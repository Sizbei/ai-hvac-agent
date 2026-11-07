# Replica M3d: Forms + site view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** main at `78520cd` or later (spec v4.1 FINAL committed; migrations through 0057 applied on dev). **Plan v3** after adversarial review round 1 (critic A: spec fidelity, SQL, concurrency, erasure, test strength; critic B: buildability, copy, task boundaries; reports in the session scratchpad `m3d/plan-r1-A.md`, `m3d/plan-r1-B.md`) and the round-2 scoped re-review (`m3d/plan-r2.md`: ruling 12 reversed by the lead, stale ruling cross-references, three nits). Every code block below was compiled (`npx tsc --noEmit` → 0) and every unit test run (`npx vitest run` → 532 files, 6 685 passed, 1 skipped, against 6 481 on `78520cd`: +204 tests) in a scratch worktree of `78520cd` rebuilt mechanically from this plan's own blocks; the integration suite, the probes and the walks were type-checked only (they need the dev DB and a dev server).

**Goal:** The office builds checklists under Settings → Forms; the technicians on a visit fill them on the job page with server-side autosave (a reload or a second phone shows the draft), submit once, the office reads and reopens them on the request sheet, erasure removes the answers; a Site page shows the history at this address; photos get a quality setting, are resized on the phone, and the Photos card takes PDFs.

**Architecture:** One hand-authored migration (0058: `forms`, `form_submissions`, NO ACTION visit and form foreign keys, and 0050's `sync_request_appointment()` re-created with one predicate added). Pure modules carry the field model, validation, the three-way merge, gates and site scope (`src/lib/forms/`). Writers are one `db.batch` each led by L_req (`lockRequestSql`): the draft writer applies a `changes` document under a revision gate with a `saveId` replay checked first; the submit writer runs under `withIdempotency` with `submit_key = derivedId(scope, "form-submit")` and an in-batch audit gated on xmin; the erase batch locks the customer's requests first and widens the attachment match. Routes are thin; the client keeps the timing and merge rules in pure helpers (`form-save-machine.ts`, `form-fill-state.ts`, `form-copy.ts`) the React pages call.

**Tech Stack:** Next.js 16 App Router (`params` / `searchParams` are Promises; native `window.history.replaceState` integrates with the router: `node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md` "Native History API"), Drizzle 0.45 on Neon neon-http (`db.batch()` = one transaction; `db.execute(sql…)` returns `.rows`; `db.transaction()` throws), drizzle-kit 0.31, zod 4, `uuid@14` (`v5` derived ids), vitest (node; mocked `db`; SQL rendered with `new PgDialect().sqlToQuery`), Playwright (walks), base shadcn primitives in the tech app, admin-ui primitives (`SectionCard`, `PageShell`, `PageHeader`, `EmptyState`, `LoadErrorState`, `ConfirmDialog`) in the office.

**Spec:** `docs/superpowers/specs/2026-11-07-replica-m3d-forms-site-view.md` (v4.1 FINAL) and its review log `docs/superpowers/specs/2026-11-07-replica-m3d-review-log.md`. The spec is the authority; this plan argues from it.

**Lead rulings / deviations** (binding; recorded again in Task 12's docs):
1. **Gate order (spec §6 vs §5.1 and test (f)).** §6 orders the preamble NOT_ASSIGNED (from `findTechAssignments`) → VISIT_ENDED → on-site window. `findTechAssignments` (`src/lib/tech/ownership.ts`) only returns rows on non-cancelled visits, so VISIT_ENDED could never fire; and test (f) wants `cancelled` → JOB_CLOSED although 0050 step 0 cancels every visit and row first. One read, `readFormGatesSql` (`src/lib/forms/form-gates.ts`), feeds one pure decision, `gateReason`, used by the preamble, the writers' zero-row map and the GETs: not on the request → 404; request `cancelled` → JOB_CLOSED; customer erased → CUSTOMER_REMOVED (v2, critic A-9: an erased customer refuses every write, whoever and wherever, so the GET's `writeBlockedReason` and the write's refusal agree); visit ended → VISIT_ENDED for a technician with a row on it, else NOT_ASSIGNED; no live row → NOT_ASSIGNED; native, not in `BILL_STATUSES` and no own arrival → NOT_ON_SITE.
2. **`techFormPreamble` is split** (`src/lib/tech/form-route-guards.ts`): `techFormFront` (session, same-origin, uuid on job and form, rate bucket) runs before the body is read; `formGateFail` / `techFormGate` (readable job, then the gate read with the body's lowercased `appointmentId`) after. `frontGates` is exported from `src/lib/tech/invoice-route-guards.ts` with the new `limit` parameter.
3. **Replay before the gates (v2, critic A-11; spec §4.2 "the replay check runs first").** The draft route runs `findDraftReplay` (the writer's own `saveId` check) BEFORE `techFormGate`; the submit route runs `formGateFail` INSIDE `withIdempotency`'s run. Most gate codes are unstored (a refusal releases the key, and a later retry re-runs the gates); CUSTOMER_REMOVED is a stored code (spec §4.3), so that refusal is stored against the key and replays, which is right: an erased customer's request never takes answers again. A retry of a write that landed answers 200 even after the visit ended or the job closed. The probe reads the caller's org and request only, and a `saveId` is a client-minted uuid, so a match proves the caller sent the write.
4. **The pre-read revision is the base (v2, critic A-3).** `prepare` answers STALE `{ revision }` when the pre-read row's revision isn't `baseRevision`, and STALE `{ revision: 0 }` for `baseRevision > 0` with no row, before any decrypt or batch: "the document it changed is the one it read" (§4.2) holds even for a client whose base runs ahead, and no empty row is orphaned.
5. **The 128 KB cap is unreachable with a valid definition (v2, critic A-4, measured).** The largest valid document — 10 long answers (the cap per form) and 50 short answers, each at its length limit in "€" (3 UTF-8 bytes per unit, the worst a valid text does) — measures 91 081 bytes (`form-values.test.ts` pins it). The cap, its 400 `{ path: ["values"] }` and the "too long to save" line stay as defence in depth; the writer test reaches them with an INJECTED snapshot of 22 long answers.
6. **Status codes the spec doesn't give:** NOT_ASSIGNED is 403 (the M3c equipment precedent); every other refusal is 409 except INVALID_INPUT and FORM_INCOMPLETE (400) and NOT_FOUND (404). STALE carries `{ revision }`; FORM_INCOMPLETE `{ fieldIds }`; the values cap `{ path: ["values"] }`.
7. **`addJobPhoto` moves** from `src/lib/tech/field-queries.ts` to `src/lib/tech/photo-writes.ts`: the spec's `runBatch([lockRequestSql…])` lives in `invoice-field-writes.ts`, which already imports `field-queries.ts` (`SIGNABLE_IN`); importing back would make a cycle.
8. **Office PATCH body** is `{ version, definition }` (fields replaced whole) or `{ version, active }` (archive / restore); the spec only says "PATCH with `{ version }`".
9. **Both technician GETs add `myRowCancelled`**: §7.3's "when the caller's row is cancelled" line needs it. The list GET's visit-level `writeBlockedReason` ignores `archived` (that is per form).
10. **Builder:** an unparseable usual-range text shows "Enter a number like 12.5 (up to 3 decimal places)." (§8's builder list has no rule for it). The first Save of a new form moves the URL with `window.history.replaceState`, not `router.replace`: `[id]/page.tsx` with `new` → a uuid changes the dynamic segment, so `router.replace` would remount the builder and lose the "replay that stays dirty" state §4.1 requires. A New form compares against its own blank start (an untouched one is not "unsaved"); a replay whose GET failed re-reads the row before the next PATCH.
11. **Forms card header** shows `· Visit #N` when N > 1 (the GET has no visit count). The status line's other-editor name is a first name ("· Sam"). The fill page is keyed by form, visit and `from`, and its submit-intent recovery runs once per intent through M3c's keyed ref (`{ key, done }`).
12. **Site (v3: the lead reversed the v2 rejection of critic A-6; spec §7.6 holds).** The Site GET returns `isLead`, computed by `isActiveLead(visit, me)` — M3c's lead expression (`visit?.leadTechnicianId === me`, `src/lib/tech/estimate-queries.ts`) exported once from `src/lib/tech/ownership.ts` and used by both the estimates GET and the Site GET, never copied. Rows aren't links, except this job's open native estimates, and only for the lead (`estimateHref`). The route test's "no key like phone, email, description, address, signature" is the spec's substring rule with ONE allowed key, the spec's own `unaddressedCount`. `leadTechnicianName` (past jobs) is the first name of `service_requests.assigned_to`. An erased customer's Site reads scope `none`, membership `none`.
13. **Integration (m) (critic A-7).** Spec §9 (m) "one [submission] on a visit cancelled before any work doesn't [count]" contradicts §5.1, where any `form_submissions` row makes its visit count (and v4.1 keeps such visits through the trigger). (m) is built as: a submission on a visit cancelled before any work DOES satisfy `missingRequired`; a visit cancelled before any work with NO submission doesn't count (its GET is 404).
14. **Submit after an unknown draft (v2, critic B-M3).** A confirmed Submit waits for the write in flight, re-sends a pending unknown draft with its own body and `saveId` and needs it to land, then submits (`submitStep`, pure); a draft that doesn't land unlocks the page instead. After a successful submit (or FORM_SUBMITTED) the page drops any queued draft and stops autosaving (`{ type: "submitted" }`), so the submitter never reads "<own name> submitted this form…".
15. **Erase:** the audit row is built in SQL (`json_build_object(…)::text`, so its text has spaces after the colons); `erased_at = COALESCE(erased_at, now())` keeps the first erase time. Caveat (critic A-10, accepted): the office uploader takes no request lock, so an office upload landing between statements 1 and 2 can make `attachmentsDeleted` one short; the DELETE still removes it (no leak).
16. **`visitState` is `'live' | 'ended'`** (spec v4.1).
17. **Plan-chosen copy** (the spec gives none; each is human copy in the canon): "Couldn't load forms." (card and office section), "Couldn't load this form.", "Couldn't load this site.", "No visits due.", "Question removed.", "Couldn't reopen the form. Please try again.", "Form not found.", "Answer the required questions." (FORM_INCOMPLETE message; the page shows its own lines), "Someone else changed this form." (STALE message; the page merges), "Filter forms…". The Reopen dialog is title "Reopen this form?" + description "The technician can change the answers and submit again." (spec §7.5's sentence split across the two, so it isn't said twice).

**Rejected or deferred** (one line each):
- Critic B-m11's optional Task 8 split: not taken; Task 8's route files are thin and share one test style, and the fixture is needed by its probe. Task 10 is split (10a pure, 10b UI).
- `tests/api/tech-photo.test.ts` (an `INTEGRATION_SUITES` entry) mocks `getAdminSession` and the old `field-queries` `addJobPhoto` export; it is already stale against the route (which uses `getTechSession`) and is not touched. The route's own `route.test.ts` is rewritten in Task 6.
- The Vercel 4.5 MB body limit and `img.decode()` memory on 48 MP captures stay unverified on dev (spec §11); Task 12 lists them for the deploy checklist.

## Global Constraints

- Gates before every commit: `npx tsc --noEmit` → 0; `npx eslint <changed files>` → 0 errors (warnings allowed, the repo carries `react-hooks/set-state-in-effect` warnings on every fetch-on-mount card); `npx vitest run` never below the live baseline (a single failure on a full run: rerun once before treating it as a regression — critic B saw one flake at the Task 5 boundary that three reruns didn't reproduce). **Capture the baseline before Task 1** (`npx vitest run 2>&1 | tail -5`, note files / passed / skipped in the task report); tests rewritten with the code they pin are reported as a delta. No jsdom/RTL: component logic lives in pure helpers tested in node. `node scripts/agent/verify-skills.mjs` → 0 missing when skills change (Task 12). After Task 1: `npx drizzle-kit generate` → "No schema changes".
- `.env.local` is the DEV Neon branch. NEVER point it at prod (`ep-withered-hill`). The integration suite, the probes and `scripts/agent/m3d-walk.mts` refuse that host.
- neon-http: `db.transaction()` throws; every writer is ONE `db.batch` (`runBatch` from `src/lib/admin/invoice-field-writes.ts`), led by `lockRequestSql(org, rid)`; the erase batch leads with `eraseLockSql`. A deadlock (40P01) is STALE, never a 500.
- SQL rules (M3b/M3c, kept): every enum literal cast (`'cancelled'::request_status`, `'open'::estimate_status`, `'active'::membership_status`, `'scheduled'::membership_visit_status`); every fragment holding `OR` in its own parentheses and pinned by a `PgDialect` render test; `organization_id = $org` on EVERY table reference, subqueries and EXISTS bodies included; array parameters through `uuidArraySql` (`src/lib/db/sql-arrays.ts`), because drizzle expands a bare JS array into `($1, $2)`.
- Answers are PII: `values_encrypted = encrypt(JSON.stringify(values))` (`src/lib/crypto.ts`), NULL for an empty document; never logged, never in an audit row, never in an error `details` (ids, a revision or a path only), never in the idempotency hash (`changesMac = macHex("hvac-form-changes-v1", canonicalJson(changes))`). Logs carry codes and ids only (`errorCode` from `@/lib/logger`); responses never carry `err.message`.
- Tenancy and envelopes: tech routes `getTechSession()` (`@/lib/auth/tech-session`), office routes `getAdminSession()` (`@/lib/auth/session`); `successResponse` / `errorResponse` / `readJsonBody` (`@/lib/api-response`); `isUuid` (`@/lib/validation/uuid`); `slidingWindow(key, max, windowMs)` with `RATE_LIMITS.adminMutation` for writes, `adminRead` for GETs, `techFormDraft` (60/min) for the draft PUT; `isSameOriginRequest` on every tech write (inside `frontGates`); office audits through `logAudit` (`@/lib/admin/audit`), the submit audit inside the writer's batch; audits only when something was created or changed, ids and enums only. Route files export only HTTP methods and `dynamic` (Next validates route exports): helpers live in `src/lib`.
- Idempotency (M3b §4): header `Idempotency-Key` (`readKey`, `@/lib/tech/invoice-write-route`); route = `request.nextUrl.pathname`; new stored codes `FORM_SUBMITTED`, `FORM_INCOMPLETE`, `ANSWERS_REMOVED`, `CUSTOMER_REMOVED`, `ANSWERS_UNREADABLE` (INVALID_INPUT already stored). Never stored: STALE, FORM_CHANGED, FORM_ARCHIVED, NOT_ASSIGNED, NOT_ON_SITE, JOB_CLOSED, VISIT_ENDED, NOT_FOUND. The draft PUT has no key. `officeId` gains the `"form"` kind.
- Copy canon: sentence case; technician copy says "job", office copy says "request"; "technician", "sign in", "cancelled", Unicode `…` and `“ ”`; no exclamation marks; human error copy only. Every user-facing string in this plan is EXACT; do not reword. Dates in the business timezone (`BUSINESS_BASE_LOCATION.timezone`, `src/lib/config/business-location.ts`).
- Tech UI: base primitives only (`Card`, `Button`, `Input`, `Textarea`, `Sheet side="bottom"`, `Skeleton`), `h-11` / `min-h-11` targets (`h-12` for the primary Submit), inline `role="alert"` errors. Office UI: admin-ui primitives, `SectionCard`. Read `~/.claude/design-principles.md` and `.claude/skills/page-tech/SKILL.md` before Tasks 10b–11; `.claude/skills/page-settings/SKILL.md` and `admin-pages` before Task 9; `.claude/skills/page-requests/SKILL.md` and `page-customers` before Tasks 6 and 11.
- Hand-authored migration recipe (AGENTS.md + spec §3): edit `schema.ts`; run `drizzle-kit generate` into a SCRATCH copy of `drizzle/` and take its `0058_snapshot.json` (`prevId` = `13842ba5-a355-4dbc-af0e-a7d44eb5db08`, the 0057 snapshot id) and journal entry (`idx` 58, `when` > 1793975702677, tag `0058_m3d_forms`); write the idempotent hand SQL with the generated names; in the repo `npx drizzle-kit generate` → "No schema changes"; `npm run db:migrate` on dev twice; compare `pg_indexes` / `pg_constraint`. Re-check `_journal.json` for the next free number first: if another workstream took 58, use the next number and rename the file and tag everywhere in this plan.
- Dev hazards: the default org `00000000-0000-0000-0000-000000000001` has a WORKING FieldPulse key and live Twilio. Never create requests through the API there, never tap statuses on its jobs. Throwaway orgs only via `createOrgCore` (`src/lib/admin/provisioning.ts`), rows inserted by SQL, orgs deleted afterwards. Probes: `NODE_OPTIONS=--conditions=react-server npx tsx probe-m3d-<task>.mts` at the repo root, deleted before committing. Walks: `scripts/agent/m3d-walk.mts` (Task 8) seeds a throwaway org, refuses when `SELECT count(*) FROM communication_jobs WHERE status='pending' AND scheduled_for <= now() + interval '15 minutes'` ≠ 0, asserts every minted token's org, and `delete <org>` asserts zero `communication_jobs` for that org before deleting it. Look at every screenshot.
- Files to re-read right before editing (other workstreams touch them): `vitest.config.ts` (Task 12 appends one line), `src/components/admin/request-detail-sheet.tsx` (Task 11 adds one section), `src/app/admin/(dashboard)/settings/page.tsx` (Task 9 adds one tab).
- Git: `git add` ONLY the task's files by path (never `git add -A` / `git add .`), never `--amend`, never force-push; other agents commit concurrently (retry once on `index.lock`). Every commit message ends with exactly these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6`
- Order: execution is SEQUENTIAL — Tasks 1, 2, … 9, 10a, 10b, 11, 12, one at a time, each committed (and reviewed) before the next starts. A task whose change breaks an existing test owns updating it; that test is listed in the task's **Files**.

## Review Focus

1. **Ids in another case.** A hand-typed `?visit=` or a client that uppercases sends `ABCDEF…`: the draft must still find its row, the gate must still find the visit, and a retried `saveId` must still be a replay. Pinned by `an uppercase visit or form id from the client binds lowercase` and `replay is checked first … SAVE.toUpperCase()` (Task 4) and `techFormGate … AID.toUpperCase()` (Task 8); each first asserts the uuid has hex letters.
2. **The business-timezone day at 11:30 PM Eastern.** "Saved · 11:30 PM" must not become "Saved · Nov 7, 11:30 PM" because UTC is already tomorrow; the membership's "due today" boundary is the same question in SQL. Pinned by `the day is the business timezone's` (Task 10a) and `upcoming visits from the start of today in the business timezone` (Task 7).
3. **Multibyte answers and the size measure.** A technician typing "€" and emoji into every long and short answer: the phone and the server must measure the same UTF-8 bytes (not string length), and the largest document a valid form can hold — measured at 91 081 bytes — must save, never trip the 128 KB cap (lead ruling 5). Pinned by `the cap is unreachable with a valid definition` and `counts UTF-8 bytes of JSON.stringify` (Task 2); the defensive refusal itself by `an injected over-128 KB document is values_too_large` (Task 4).
4. **An edit while a save is in flight.** The technician types "16x25" (sent), then "16x25x1" before the answer lands: the field must stay touched and go in the next PUT, never be dropped as "saved". Pinned by `an edit during the flight survives the landing` (Task 10a).
5. **The office changes or archives a form mid-job.** A version-1 draft keeps working from its snapshot and submits on version 1; restoring an archived form whose name was reused answers NAME_TAKEN, not a 500. Pinned by integration (e) and (h) (Task 12) and `restoring an archived form whose name is now taken → name_taken` (Task 5).

---

## File map (exclusive ownership)

| task | creates | modifies |
| --- | --- | --- |
| 1 | `drizzle/0058_m3d_forms.sql`, `drizzle/meta/0058_snapshot.json` (generated), `src/lib/forms/migration-0058.test.ts` | `drizzle/meta/_journal.json`, `src/lib/db/schema.ts` |
| 2 | `src/lib/forms/form-schema.ts` (+test), `src/lib/forms/form-values.ts` (+test), `src/lib/format/plural.ts` (+test) | — |
| 3 | `src/lib/forms/form-gates.ts` (+test), `src/lib/forms/site-scope.ts` (+test), `src/lib/tech/upload-limits.ts`, `src/lib/db/sql-arrays.ts` | `src/lib/http/idempotency.ts`, `src/lib/http/idempotency.test.ts`, `src/lib/http/idempotency-codes.ts`, `src/lib/crypto.ts`, `src/lib/crypto.test.ts`, `src/lib/admin/location-queries.ts` |
| 4 | `src/lib/tech/form-writes.ts` (+test), `src/lib/tech/form-errors.ts` (+test) | — |
| 5 | `src/lib/admin/form-queries.ts` (+test) | — |
| 6 | `src/lib/admin/erasure-sql.ts` (+test), `src/lib/tech/photo-writes.ts` (+test) | `src/lib/admin/erasure-queries.ts`, `src/lib/admin/erasure-queries.test.ts`, `src/lib/tech/field-queries.ts` (photo removal), `src/lib/tech/field-queries.test.ts`, `src/app/api/tech/jobs/[id]/photo/route.ts`, `src/app/api/tech/jobs/[id]/photo/route.test.ts` |
| 7 | `src/lib/tech/form-view.ts` (+test), `src/lib/tech/form-reads.ts` (+test), `src/lib/tech/site-view.ts`, `src/lib/tech/site-queries.ts` (+test) | `src/lib/tech/ownership.ts` (`isActiveLead`), `src/lib/tech/ownership.test.ts`, `src/lib/tech/estimate-queries.ts` (uses it) |
| 8 | `scripts/agent/m3d-walk.mts`, `src/lib/tech/form-route-guards.ts` (+test), `src/lib/forms/form-bodies.ts`, `src/lib/tech/form-submit-hash.ts`, `src/lib/admin/form-route-copy.ts`, routes `src/app/api/tech/jobs/[id]/forms/{route,[formId]/route,[formId]/draft/route,[formId]/submit/route}.ts` (+`forms/route.test.ts`), `src/app/api/tech/jobs/[id]/site/route.ts` (+test), `src/app/api/admin/settings/forms/{route,[id]/route}.ts` (+`route.test.ts`), `src/app/api/admin/requests/[id]/forms/{route,[submissionId]/reopen/route}.ts` (+`route.test.ts`) | `src/lib/rate-limit.ts`, `src/lib/tech/invoice-route-guards.ts` |
| 9 | `src/lib/admin/form-builder.ts` (+test), `src/lib/admin/forms-tab.ts` (+test), `src/components/admin/settings/forms-panel.tsx`, `src/components/admin/forms/{form-builder-client,form-field-editor}.tsx`, `src/app/admin/(dashboard)/settings/forms/[id]/page.tsx` | `src/lib/admin/settings-tabs.ts`, `src/lib/admin/settings-tabs.test.ts`, `src/app/admin/(dashboard)/settings/page.tsx` |
| 10a | `src/lib/tech/form-fill-state.ts` (+test), `src/lib/tech/form-save-machine.ts` (+test), `src/lib/tech/form-copy.ts` (+test) | — |
| 10b | `src/components/tech/forms/{forms-card,form-field-input,form-fill-client}.tsx`, `src/app/tech/jobs/[id]/forms/[formId]/page.tsx` | `src/lib/tech/field-queries.ts` (`activeVisitId`), `src/components/tech/tech-job-summary.tsx`, `src/components/tech/close-out-sheet.tsx`, `src/components/tech/tech-job-detail-client.tsx` |
| 11 | `src/lib/tech/site-display.ts` (+test), `src/components/tech/site/{fetch-site.ts,site-card.tsx,site-page-client.tsx}`, `src/app/tech/jobs/[id]/site/page.tsx`, `src/lib/tech/photo-resize.ts` (+test), `src/lib/tech/photo-prepare.ts`, `src/lib/admin/request-forms-view.ts` (+test), `src/components/admin/request-forms-section.tsx` | `src/components/tech/tech-job-detail-client.tsx` (Site card), `src/components/tech/job-photos-card.tsx`, `src/lib/tech/job-page-state.ts`, `src/lib/tech/job-page-state.test.ts`, `src/components/admin/request-detail-sheet.tsx` |
| 12 | `tests/integration/field-forms.test.ts` | `vitest.config.ts`, `.claude/skills/{page-tech,page-settings,page-requests,page-customers}/SKILL.md`, `replica/{features.csv,parity.md,build-log.md,architecture.md}`, memory `replica-program-fp-st.md` (not committed) |

The spec §9 end-to-end walk runs inside Tasks 9, 10b and 11 (each walks its own surfaces on a fresh throwaway org) plus the erase step in Task 11.

---
### Task 1: Migration 0058 — tables, NO ACTION keys, the visit trigger with one predicate

**Files:**
- Create: `drizzle/0058_m3d_forms.sql`, `drizzle/meta/0058_snapshot.json` (generated), `src/lib/forms/migration-0058.test.ts`
- Modify: `drizzle/meta/_journal.json` (generated entry), `src/lib/db/schema.ts` (two tables appended at the end of the file)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `forms` (id = `officeId("form", org, clientToken)`, `fields` jsonb array, `job_type_ids uuid[]`, `required`, `active`, `version` CAS starting at 1) and `form_submissions` (natural key `(appointment_id, form_id, service_request_id)`, `values_encrypted`, `status` `draft|submitted`, `revision`, `last_save_id`, `submit_key`, `erased_at`); schema exports `forms`, `formSubmissions`; `sync_request_appointment()` keeps visit #1 when it has any `form_submissions` row.

- [ ] **Step 1: Write the failing migration test** — `src/lib/forms/migration-0058.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Migration 0058 (M3d spec §3, §3.4): idempotent shape, and the re-created
 * visit trigger is 0050's body byte for byte except the one predicate line.
 */
const root = join(__dirname, "..", "..", "..");
const read = (f: string) => readFileSync(join(root, "drizzle", f), "utf8");
const SQL_0058 = read("0058_m3d_forms.sql");
const SQL_0050 = read("0050_m3a_run_the_day.sql");

const START = "CREATE OR REPLACE FUNCTION sync_request_appointment()";
const END = "$$ LANGUAGE plpgsql;";
function functionBody(src: string): string {
  const start = src.indexOf(START);
  const end = src.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error("function not found");
  return src.slice(start, end + END.length);
}

const OLD_LINE = "      ) INTO v_has_progress;";
const NEW_LINE = "      ) OR EXISTS (SELECT 1 FROM form_submissions s WHERE s.appointment_id = v_appt_id) INTO v_has_progress;";

describe("migration 0058", () => {
  const statements = SQL_0058.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

  it("has 23 statements, the trigger function last", () => {
    expect(statements).toHaveLength(23);
    expect(statements.at(-1)).toContain(START);
  });

  it("creates forms before form_submissions, both IF NOT EXISTS", () => {
    expect(statements[0]).toMatch(/^-- M3d[\s\S]*CREATE TABLE IF NOT EXISTS "forms"/);
    expect(statements[1]).toMatch(/^CREATE TABLE IF NOT EXISTS "form_submissions"/);
  });

  it("wraps every constraint in its own duplicate_object block", () => {
    const adds = statements.filter((s) => s.includes("ADD CONSTRAINT"));
    expect(adds).toHaveLength(15);
    for (const s of adds) {
      expect(s.startsWith("DO $$ BEGIN")).toBe(true);
      expect(s.endsWith("EXCEPTION WHEN duplicate_object THEN NULL; END $$;")).toBe(true);
      expect(s.match(/ADD CONSTRAINT/g)).toHaveLength(1);
    }
  });

  it("indexes are IF NOT EXISTS; the name index is lower(name) WHERE active", () => {
    const idx = statements.filter((s) => s.includes("INDEX"));
    expect(idx).toHaveLength(5);
    for (const s of idx) expect(s).toMatch(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS/);
    expect(SQL_0058).toContain(`ON "forms" USING btree ("organization_id",lower("name")) WHERE "forms"."active"`);
    expect(SQL_0058).toContain(`"form_submissions_visit_form_unique" ON "form_submissions" USING btree ("appointment_id","form_id","service_request_id")`);
  });

  it("the visit and form foreign keys are NO ACTION; the request and org ones cascade", () => {
    expect(SQL_0058).toContain(`FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action`);
    expect(SQL_0058).toContain(`FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action`);
    expect(SQL_0058).toContain(`FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade`);
  });

  it("the trigger body is 0050's with only the v_has_progress predicate changed", () => {
    const before = functionBody(SQL_0050);
    const after = functionBody(SQL_0058);
    expect(before.split(OLD_LINE)).toHaveLength(2);
    expect(after).toBe(before.replace(OLD_LINE, NEW_LINE));
    const a = before.split("\n");
    const b = after.split("\n");
    expect(b).toHaveLength(a.length);
    expect(a.filter((line, i) => line !== b[i])).toEqual([OLD_LINE]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/forms/migration-0058.test.ts`
Expected: FAIL — `ENOENT … drizzle/0058_m3d_forms.sql`.

- [ ] **Step 3: Schema.** Append to the end of `src/lib/db/schema.ts` (every helper used — `pgTable`, `uuid`, `text`, `jsonb`, `boolean`, `integer`, `timestamp`, `index`, `uniqueIndex`, `check`, `sql` — is already imported at the top of the file):

```diff
diff --git a/src/lib/db/schema.ts b/src/lib/db/schema.ts
index 90f26b8..6c42157 100644
--- a/src/lib/db/schema.ts
+++ b/src/lib/db/schema.ts
@@ -3529,3 +3529,71 @@ export const fpImportRuns = pgTable(
     ),
   ],
 );
+
+// M3d: office-built job forms (checklists). A row exists only once a valid
+// definition (>= 1 non-heading question) was saved; archived, never deleted.
+// `version` is the CAS token and the snapshot version (+1 per PATCH).
+export const forms = pgTable(
+  "forms",
+  {
+    id: uuid("id").primaryKey(),
+    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
+    name: text("name").notNull(),
+    description: text("description"),
+    fields: jsonb("fields").notNull(),
+    jobTypeIds: uuid("job_type_ids").array().notNull().default(sql`'{}'::uuid[]`),
+    required: boolean("required").notNull().default(false),
+    active: boolean("active").notNull().default(true),
+    version: integer("version").notNull().default(1),
+    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
+    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
+    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
+  },
+  (table) => [
+    index("forms_org_active_idx").on(table.organizationId, table.active),
+    uniqueIndex("forms_org_name_active_unique").on(table.organizationId, sql`lower(${table.name})`).where(sql`${table.active}`),
+    check("forms_fields_array_check", sql`jsonb_typeof(${table.fields}) = 'array'`),
+  ],
+);
+
+// M3d: one submission per visit per form. The snapshot (form_name,
+// form_version, fields) is taken when the row is created. appointment_id and
+// form_id are NO ACTION: a request delete or an org purge removes the visit and
+// the submission in one statement; a lone visit delete that would orphan
+// answers fails (the 0058 trigger keeps visits that have a submission).
+export const formSubmissions = pgTable(
+  "form_submissions",
+  {
+    id: uuid("id").defaultRandom().primaryKey(),
+    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
+    formId: uuid("form_id").notNull().references(() => forms.id),
+    serviceRequestId: uuid("service_request_id").notNull().references(() => serviceRequests.id, { onDelete: "cascade" }),
+    appointmentId: uuid("appointment_id").notNull().references(() => appointments.id),
+    formName: text("form_name").notNull(),
+    formVersion: integer("form_version").notNull(),
+    fields: jsonb("fields").notNull(),
+    // encrypt(JSON.stringify(values)); NULL = no answers, or erased.
+    valuesEncrypted: text("values_encrypted"),
+    status: text("status").notNull().default("draft"),
+    revision: integer("revision").notNull().default(0),
+    lastSaveId: uuid("last_save_id"),
+    submitKey: uuid("submit_key"),
+    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
+    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
+    submittedBy: uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
+    submittedAt: timestamp("submitted_at", { withTimezone: true }),
+    erasedAt: timestamp("erased_at", { withTimezone: true }),
+    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
+    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
+  },
+  (table) => [
+    uniqueIndex("form_submissions_visit_form_unique").on(table.appointmentId, table.formId, table.serviceRequestId),
+    index("form_submissions_org_request_idx").on(table.organizationId, table.serviceRequestId),
+    index("form_submissions_form_idx").on(table.formId),
+    check("form_submissions_fields_array_check", sql`jsonb_typeof(${table.fields}) = 'array'`),
+    check("form_submissions_status_check", sql`${table.status} IN ('draft','submitted')`),
+    check("form_submissions_revision_check", sql`${table.revision} >= 0`),
+    check("form_submissions_submitted_check", sql`(${table.status} = 'submitted') = (${table.submittedAt} IS NOT NULL)`),
+    check("form_submissions_erased_check", sql`${table.erasedAt} IS NULL OR ${table.valuesEncrypted} IS NULL`),
+  ],
+);
```

- [ ] **Step 4: Generate into a scratch copy** (spec §3 procedure; the repo's `drizzle/` is not written by the generator):

```bash
# --out must be RELATIVE: drizzle-kit prefixes "./" to it (an absolute path silently restarts at 0000).
rm -rf .m3d-drizzle && mkdir .m3d-drizzle && cp -R drizzle .m3d-drizzle/drizzle
npx drizzle-kit generate --name m3d_forms --dialect postgresql --schema src/lib/db/schema.ts --out .m3d-drizzle/drizzle
cp .m3d-drizzle/drizzle/meta/0058_snapshot.json drizzle/meta/0058_snapshot.json
tail -8 .m3d-drizzle/drizzle/meta/_journal.json
cat .m3d-drizzle/drizzle/0058_m3d_forms.sql
# after the comparison below: rm -rf .m3d-drizzle
```

Check: the snapshot's `"prevId"` is `13842ba5-a355-4dbc-af0e-a7d44eb5db08`; the scratch journal's last entry is `{ "idx": 58, "version": "7", "when": <generated, > 1793975702677>, "tag": "0058_m3d_forms", "breakpoints": true }` — append exactly that entry to `drizzle/meta/_journal.json`. The generated SQL must carry the same names as the hand SQL below (`forms_fields_array_check`, `forms_organization_id_organizations_id_fk`, `forms_created_by_users_id_fk`, the five `form_submissions_*_check`, `form_submissions_{organization_id_organizations_id,form_id_forms_id,service_request_id_service_requests_id,appointment_id_appointments_id,started_by_users_id,updated_by_users_id,submitted_by_users_id}_fk`, the five indexes); diff it statement by statement against the hand SQL (modulo `IF NOT EXISTS`, the `DO $$` wrappers and the trigger function, which drizzle doesn't model). In the scratch run the form_submissions FKs for `form_id` and `appointment_id` read `ON DELETE no action`.

- [ ] **Step 5: Hand-authored SQL.** Write `drizzle/0058_m3d_forms.sql` as below. The trigger function is lines 36–164 of `drizzle/0050_m3a_run_the_day.sql` copied VERBATIM with line 79 (`      ) INTO v_has_progress;`) replaced by the one predicate line; produce it mechanically and check it:

```bash
# the 23-statement file below = this header + 0050's function with one line changed
diff <(sed -n '36,164p' drizzle/0050_m3a_run_the_day.sql) <(sed -n '/^CREATE OR REPLACE FUNCTION/,$p' drizzle/0058_m3d_forms.sql)
# expected output: exactly
# 44c44
# <       ) INTO v_has_progress;
# ---
# >       ) OR EXISTS (SELECT 1 FROM form_submissions s WHERE s.appointment_id = v_appt_id) INTO v_has_progress;
```

```sql
-- M3d Forms: office-built job forms, per-visit submissions, and the visit
-- trigger keeping a visit that has a submission. Idempotent throughout (one DO
-- block per constraint so a partial re-run adds the rest).
CREATE TABLE IF NOT EXISTS "forms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"fields" jsonb NOT NULL,
	"job_type_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "form_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"service_request_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"form_name" text NOT NULL,
	"form_version" integer NOT NULL,
	"fields" jsonb NOT NULL,
	"values_encrypted" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"last_save_id" uuid,
	"submit_key" uuid,
	"started_by" uuid,
	"updated_by" uuid,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "forms" ADD CONSTRAINT "forms_fields_array_check" CHECK (jsonb_typeof("forms"."fields") = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "forms" ADD CONSTRAINT "forms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "forms" ADD CONSTRAINT "forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_fields_array_check" CHECK (jsonb_typeof("form_submissions"."fields") = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_status_check" CHECK ("form_submissions"."status" IN ('draft','submitted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_revision_check" CHECK ("form_submissions"."revision" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_submitted_check" CHECK (("form_submissions"."status" = 'submitted') = ("form_submissions"."submitted_at" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_erased_check" CHECK ("form_submissions"."erased_at" IS NULL OR "form_submissions"."values_encrypted" IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forms_org_active_idx" ON "forms" USING btree ("organization_id","active");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "forms_org_name_active_unique" ON "forms" USING btree ("organization_id",lower("name")) WHERE "forms"."active";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "form_submissions_visit_form_unique" ON "form_submissions" USING btree ("appointment_id","form_id","service_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_submissions_org_request_idx" ON "form_submissions" USING btree ("organization_id","service_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_submissions_form_idx" ON "form_submissions" USING btree ("form_id");
--> statement-breakpoint
-- Trigger v3: 0050's body VERBATIM except one predicate. v_has_progress also
-- counts any form_submissions row on visit #1 (an empty draft included), so an
-- unassigned, undated request keeps a visit that holds answers (times nulled,
-- lead demoted) instead of deleting it. A render test diffs this body against
-- drizzle/0050_m3a_run_the_day.sql and allows only that line.
CREATE OR REPLACE FUNCTION sync_request_appointment()
RETURNS TRIGGER AS $$
DECLARE
  v_appt_id uuid;
  v_window_end timestamptz;
  v_old_assigned uuid;
  v_has_progress boolean;
BEGIN
  v_old_assigned := CASE WHEN TG_OP = 'UPDATE' THEN OLD.assigned_to ELSE NULL END;

  -- 0. Cancelling the request cancels every visit, every open assignment and
  --    closes every open job time entry on the request.
  IF NEW.status = 'cancelled' THEN
    UPDATE appointments SET cancelled_at = COALESCE(cancelled_at, now()),
        version = version + 1, updated_at = now()
      WHERE service_request_id = NEW.id AND cancelled_at IS NULL;
    UPDATE appointment_assignments a SET status = 'cancelled'
      FROM appointments p
      WHERE a.appointment_id = p.id AND p.service_request_id = NEW.id
        AND a.status NOT IN ('completed','cancelled');
    UPDATE technician_time_entries t
      SET clock_out_at = now(),
          minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.clock_in_at)) / 60))::int,
          labor_rate_cents = COALESCE(u.labor_rate_cents, 0),
          labor_cost_cents = ROUND(GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.clock_in_at)) / 60)) / 60.0 * COALESCE(u.labor_rate_cents, 0))::int,
          updated_at = now()
      FROM users u
      WHERE u.id = t.technician_id AND t.service_request_id = NEW.id
        AND t.kind = 'job' AND t.clock_out_at IS NULL;
  END IF;

  -- 1. Nothing to mirror: delete #1 when it has no progress, else null its
  --    times and demote the lead (keeping 'completed').
  IF NEW.scheduled_date IS NULL AND NEW.arrival_window_start IS NULL
     AND NEW.arrival_window_end IS NULL AND NEW.assigned_to IS NULL THEN
    SELECT id INTO v_appt_id FROM appointments
      WHERE service_request_id = NEW.id AND appointment_number = 1;
    IF v_appt_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM appointment_assignments a
        WHERE a.appointment_id = v_appt_id
          AND (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL
               OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL)
      ) OR EXISTS (SELECT 1 FROM form_submissions s WHERE s.appointment_id = v_appt_id) INTO v_has_progress;
      IF NOT v_has_progress THEN
        DELETE FROM appointments WHERE id = v_appt_id;
      ELSE
        UPDATE appointments
          SET scheduled_date = NULL, starts_at = NULL, ends_at = NULL,
              arrival_window_start = NULL, arrival_window_end = NULL,
              version = version + 1, updated_at = now()
          WHERE id = v_appt_id;
        UPDATE appointment_assignments SET is_lead = false,
            status = CASE WHEN status = 'completed' THEN status ELSE 'cancelled' END
          WHERE appointment_id = v_appt_id AND is_lead;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  v_window_end := CASE
    WHEN NEW.arrival_window_end IS NOT NULL AND NEW.arrival_window_start IS NOT NULL
         AND NEW.arrival_window_end <= NEW.arrival_window_start THEN NULL
    ELSE NEW.arrival_window_end END;

  -- 2. Upsert visit #1 (starts_at/ends_at from the window only).
  INSERT INTO appointments (organization_id, service_request_id, appointment_number,
      scheduled_date, starts_at, ends_at, arrival_window_start, arrival_window_end, cancelled_at)
  VALUES (NEW.organization_id, NEW.id, 1, NEW.scheduled_date,
      NEW.arrival_window_start, v_window_end, NEW.arrival_window_start, v_window_end,
      CASE WHEN NEW.status = 'cancelled' THEN now() ELSE NULL END)
  ON CONFLICT (service_request_id, appointment_number) DO UPDATE SET
      scheduled_date = EXCLUDED.scheduled_date,
      starts_at = EXCLUDED.starts_at,
      ends_at = EXCLUDED.ends_at,
      arrival_window_start = EXCLUDED.arrival_window_start,
      arrival_window_end = EXCLUDED.arrival_window_end,
      -- a visit a hold ended (cancelled_at set while the request lives on) stays
      -- ended; only leaving 'cancelled' clears it
      cancelled_at = CASE WHEN NEW.status = 'cancelled'
                            THEN COALESCE(appointments.cancelled_at, now())
                          WHEN TG_OP = 'UPDATE' AND OLD.status = 'cancelled' THEN NULL
                          ELSE appointments.cancelled_at END,
      version = appointments.version + 1,
      updated_at = now()
  RETURNING id INTO v_appt_id;

  -- 3. Lead assignment follows assigned_to.
  IF TG_OP = 'INSERT' OR v_old_assigned IS DISTINCT FROM NEW.assigned_to THEN
    DELETE FROM appointment_assignments a
      WHERE a.appointment_id = v_appt_id AND a.is_lead
        AND (NEW.assigned_to IS NULL OR a.technician_id <> NEW.assigned_to)
        AND a.en_route_at IS NULL AND a.arrived_at IS NULL
        AND a.started_at IS NULL AND a.completed_at IS NULL;
    UPDATE appointment_assignments a SET is_lead = false,
        status = CASE WHEN a.status = 'completed' THEN a.status ELSE 'cancelled' END
      WHERE a.appointment_id = v_appt_id AND a.is_lead
        AND (NEW.assigned_to IS NULL OR a.technician_id <> NEW.assigned_to);
    IF NEW.assigned_to IS NOT NULL THEN
      INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id,
          is_lead, status, assigned_at)
      VALUES (NEW.organization_id, v_appt_id, NEW.assigned_to, true, NEW.status, now())
      ON CONFLICT (appointment_id, technician_id) DO UPDATE SET
          is_lead = true,
          status = CASE WHEN appointment_assignments.status <> 'cancelled'
                         AND appointment_assignments.en_route_at IS NULL
                         AND appointment_assignments.arrived_at IS NULL
                         AND appointment_assignments.started_at IS NULL
                         AND appointment_assignments.completed_at IS NULL
                        THEN EXCLUDED.status ELSE appointment_assignments.status END;
    END IF;
  ELSIF NEW.assigned_to IS NOT NULL AND NEW.status <> 'cancelled' THEN
    -- 4. Status mirror for the lead, only until the tech app has written it.
    -- Only a NON-TERMINAL untouched row is mirrored (pending included: a lead
    -- row inserted while the request is pending must follow it to scheduled),
    -- and never to a terminal value: a row a hold has cancelled must stay
    -- cancelled, and request 'completed' leaves rows alone (rule d).
    IF NEW.status NOT IN ('completed','cancelled') THEN
      UPDATE appointment_assignments SET status = NEW.status
        WHERE appointment_id = v_appt_id AND technician_id = NEW.assigned_to AND is_lead
          AND status NOT IN ('completed','cancelled')
          AND en_route_at IS NULL AND arrived_at IS NULL
          AND started_at IS NULL AND completed_at IS NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

- [ ] **Step 6: Run the test and the generator check**

Run: `npx vitest run src/lib/forms/migration-0058.test.ts` → PASS (6 tests).
Run: `npx drizzle-kit generate` → "No schema changes, nothing to migrate".

- [ ] **Step 7: Migrate dev twice and probe.** `npm run db:migrate` twice (the second applies nothing). Probe `probe-m3d-1.mts` at the repo root:

```ts
import { config } from "dotenv";
config({ path: ".env.local" });
if ((process.env.DATABASE_URL ?? "").includes("ep-withered-hill")) throw new Error("prod");
const { db } = await import("./src/lib/db");
const { sql } = await import("drizzle-orm");
const idx = await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename IN ('forms','form_submissions') ORDER BY 1`);
const cons = await db.execute(sql`SELECT conname, confdeltype FROM pg_constraint WHERE conrelid IN ('forms'::regclass, 'form_submissions'::regclass) ORDER BY 1`);
const fn = await db.execute(sql`SELECT position('form_submissions' in prosrc) > 0 AS guarded FROM pg_proc WHERE proname = 'sync_request_appointment'`);
console.log(JSON.stringify({ idx: idx.rows, cons: cons.rows, fn: fn.rows }));
process.exit(0);
```

Run `NODE_OPTIONS=--conditions=react-server npx tsx probe-m3d-1.mts`. Expected: 7 index names (the two pkeys + the five), 15 named constraints plus the two pkeys, `form_submissions_appointment_id_appointments_id_fk` and `form_submissions_form_id_forms_id_fk` with `confdeltype` `a` (NO ACTION), the request/org keys `c`, the user keys `n`; `guarded: true`. Delete the probe.

- [ ] **Step 8: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/db/schema.ts src/lib/forms/migration-0058.test.ts && npx vitest run
git add drizzle/0058_m3d_forms.sql drizzle/meta/0058_snapshot.json drizzle/meta/_journal.json src/lib/db/schema.ts src/lib/forms/migration-0058.test.ts
git commit -m "$(cat <<'EOF'
feat(m3d): migration 0058 (forms, form_submissions, visit trigger keeps visits with answers)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 2: The form model — definitions, values, merge, the plural helper

**Files:**
- Create: `src/lib/forms/form-schema.ts`, `src/lib/forms/form-schema.test.ts`, `src/lib/forms/form-values.ts`, `src/lib/forms/form-values.test.ts`, `src/lib/format/plural.ts`, `src/lib/format/plural.test.ts`

**Interfaces:**
- Consumes: nothing (zod only).
- Produces (all pure, client-safe):
  - `form-schema.ts`: `FIELD_TYPES`, `type FieldType`, `FIELD_ID_RE`, `OPTION_ID_RE`, `FORM_LIMITS` (`name 80, description 300, label 120, help 200, unit 12, optionLabel 60, minOptions 2, maxOptions 12, maxFields 60, maxLongText 10, definitionBytes 65536, shortText 200, longText 2000, numberBound 1_000_000, valuesBytes 131072, maxForms 100`), `interface ChoiceOption`, `type FormField` (discriminated by `type`), `utf8Bytes(s)`, `isFormNumber(x)`, `formFieldsSchema`, `formDefinitionSchema`, `interface FormDefinition { name; description: string | null; jobTypeIds: readonly string[]; required; fields: readonly FormField[] }`, `firstIssuePath(error): (string|number)[]`, `parseStoredFields(raw): readonly FormField[] | null`, `questionCount(fields)`.
  - `form-values.ts`: `type FieldValue = true | string | number`, `type FormValues`, `type Changes` (`Record<string, FieldValue | null>`), `hasControlChars`, `stripControlChars`, `draftValueOk(field, value)`, `applyChanges(fields, doc, changes): { ok: true; values } | { ok: false; fieldIds }`, `valuesBytes`, `valuesTooLarge`, `isAnswered`, `missingRequired(fields, values): string[]`, `carryValues(fields, values)`, `droppedByCarry(before, after)`, `mergeDraft(base, mine, theirs): { values; foreignChange }`, `type NumberInputState` (`{ kind: "empty" | "partial" | "invalid" | "out_of_bounds" } | { kind: "value"; value }`), `numberInputState(raw)`, `rangeNote(field, value)`, `answerText(field, value)`.
  - `plural.ts`: `plural(n, one, many)` → `"1 question"` / `"3 questions"`.

- [ ] **Step 1: Write the failing tests** — `src/lib/forms/form-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formDefinitionSchema, formFieldsSchema, firstIssuePath, isFormNumber, parseStoredFields, questionCount, utf8Bytes, type FormField } from "./form-schema";

const id = (n: number) => `f_${String(n).padStart(10, "0")}`;
const cb = (n: number, over: Partial<FormField> = {}) => ({ id: id(n), type: "checkbox", label: `Item ${n}`, required: false, ...over });
const def = (fields: unknown[]) => ({ name: "Maintenance checklist", description: null, jobTypeIds: [], required: false, fields });
const pathOf = (fields: unknown[]) => {
  const r = formFieldsSchema.safeParse(fields);
  return r.success ? null : firstIssuePath(r.error);
};

describe("formDefinitionSchema (spec §3.3)", () => {
  it("accepts every field type with its extras and trims the name", () => {
    const r = formDefinitionSchema.safeParse({
      ...def([
        { id: id(1), type: "heading", label: "Outdoor unit", required: false },
        cb(2, { required: true }),
        { id: id(3), type: "yes_no", label: "Coil clean?", required: true, allowNa: true },
        { id: id(4), type: "short_text", label: "Filter size", required: false, help: "e.g. 16x25x1" },
        { id: id(5), type: "long_text", label: "Findings", required: false },
        { id: id(6), type: "number", label: "Suction", required: true, unit: "psi", usualMin: 100, usualMax: 140 },
        { id: id(7), type: "choice", label: "Filter", required: false, options: [{ id: "o_aaaaaaaa", label: "Clean" }, { id: "o_bbbbbbbb", label: "Dirty" }] },
      ]),
      name: "  Maintenance checklist  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Maintenance checklist");
  });

  it("refuses a form with only headings, more than 60 fields, more than 10 long answers", () => {
    expect(pathOf([{ id: id(1), type: "heading", label: "H", required: false }])).toEqual([]);
    expect(pathOf(Array.from({ length: 61 }, (_, i) => cb(i)))).toEqual([]);
    expect(pathOf(Array.from({ length: 11 }, (_, i) => ({ id: id(i), type: "long_text", label: "L", required: false })))).toEqual([]);
    expect(pathOf([])).toEqual([]);
  });

  it("refuses a required heading, duplicate field ids, bad ids", () => {
    expect(pathOf([cb(1), { id: id(2), type: "heading", label: "H", required: true }])).toEqual([1, "required"]);
    expect(pathOf([cb(1), cb(1)])).toEqual([1, "id"]);
    expect(pathOf([{ ...cb(1), id: "f_SHORT" }])).toEqual([0, "id"]);
  });

  it("choice: 2–12 options, option ids o_ + 8, labels unique case-insensitively", () => {
    const ch = (options: unknown[]) => [{ id: id(1), type: "choice", label: "C", required: false, options }];
    expect(pathOf(ch([{ id: "o_aaaaaaaa", label: "A" }]))).toEqual([0, "options"]);
    expect(pathOf(ch([{ id: "o_aaaaaaaa", label: "Clean" }, { id: "o_bbbbbbbb", label: "clean" }]))).toEqual([0, "options"]);
    expect(pathOf(ch([{ id: "o_aaaaaaaa", label: "A" }, { id: "o_x", label: "B" }]))).toEqual([0, "options", 1, "id"]);
  });

  it("number: unit ≤ 12, usual range low ≤ high, bounds and decimals", () => {
    const n = (over: object) => [{ id: id(1), type: "number", label: "N", required: false, ...over }];
    expect(pathOf(n({ unit: "x".repeat(13) }))).toEqual([0, "unit"]);
    expect(pathOf(n({ usualMin: 15, usualMax: 5 }))).toEqual([0, "usualMax"]);
    expect(pathOf(n({ usualMin: 1.2345 }))).toEqual([0, "usualMin"]);
    expect(pathOf(n({ usualMin: 5, usualMax: 5 }))).toBeNull();
  });

  it("a definition over 64 KB is refused", () => {
    const options = Array.from({ length: 12 }, (_, j) => ({ id: `o_${String(j).padStart(8, "0")}`, label: `${j}${"€".repeat(58)}` }));
    const big = Array.from({ length: 30 }, (_, i) => ({ id: id(i), type: "choice", label: "C", required: false, options }));
    expect(utf8Bytes(JSON.stringify(big))).toBeGreaterThan(64 * 1024);
    expect(pathOf(big)).toEqual([]);
  });

  it("isFormNumber, parseStoredFields, questionCount", () => {
    expect([12.5, -0.001, 999_999.999].every(isFormNumber)).toBe(true);
    expect([1_000_000, 1.2345, Number.NaN, Infinity, "1"].some(isFormNumber)).toBe(false);
    expect(parseStoredFields([{ nope: true }])).toBeNull();
    const fields = parseStoredFields([cb(1), { id: id(2), type: "heading", label: "H", required: false }])!;
    expect(questionCount(fields)).toBe(1);
  });
});
```

`src/lib/forms/form-values.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FORM_LIMITS, formFieldsSchema, type FormField } from "./form-schema";
import {
  answerText, applyChanges, carryValues, draftValueOk, droppedByCarry, hasControlChars, mergeDraft, missingRequired,
  numberInputState, rangeNote, stripControlChars, valuesBytes, valuesTooLarge,
} from "./form-values";

const F = {
  tick: { id: "f_0000000001", type: "checkbox", label: "Filter changed", required: true },
  yn: { id: "f_0000000002", type: "yes_no", label: "Coil clean?", required: true, allowNa: true },
  ynNoNa: { id: "f_0000000003", type: "yes_no", label: "Drain clear?", required: false },
  short: { id: "f_0000000004", type: "short_text", label: "Filter size", required: false },
  long: { id: "f_0000000005", type: "long_text", label: "Findings", required: false },
  num: { id: "f_0000000006", type: "number", label: "Suction", required: true, unit: "psi", usualMin: 100, usualMax: 140 },
  choice: { id: "f_0000000007", type: "choice", label: "Filter", required: false, options: [{ id: "o_aaaaaaaa", label: "Clean" }, { id: "o_bbbbbbbb", label: "Dirty" }] },
  head: { id: "f_0000000008", type: "heading", label: "Outdoor unit", required: false },
} as const satisfies Record<string, FormField>;
const FIELDS: FormField[] = Object.values(F);

describe("draftValueOk (spec §3.3)", () => {
  it("accepts each type's value and null as cleared; refuses headings", () => {
    expect(draftValueOk(F.tick, true)).toBe(true);
    expect(draftValueOk(F.tick, false)).toBe(false);
    expect(draftValueOk(F.yn, "na")).toBe(true);
    expect(draftValueOk(F.ynNoNa, "na")).toBe(false);
    expect(draftValueOk(F.short, "16x25x1")).toBe(true);
    expect(draftValueOk(F.short, "x".repeat(201))).toBe(false);
    expect(draftValueOk(F.long, "x".repeat(2000))).toBe(true);
    expect(draftValueOk(F.num, 118.25)).toBe(true);
    expect(draftValueOk(F.num, 12.3456)).toBe(false);
    expect(draftValueOk(F.choice, "o_aaaaaaaa")).toBe(true);
    expect(draftValueOk(F.choice, "o_cccccccc")).toBe(false);
    expect(draftValueOk(F.short, null)).toBe(true);
    expect(draftValueOk(F.head, null)).toBe(false);
  });

  it("refuses C0 controls other than tab, LF and CR; the client strips them", () => {
    expect(draftValueOk(F.long, "line 1\nline 2\tx\r")).toBe(true);
    expect(draftValueOk(F.short, "bell\u0007")).toBe(false);
    expect(hasControlChars("a\u0000b")).toBe(true);
    expect(stripControlChars("a\u0000b\u001Fc\n")).toBe("abc\n");
  });

  it("does not range-check: an outside reading is a valid draft", () => {
    expect(draftValueOk(F.num, 300)).toBe(true);
  });
});

describe("applyChanges", () => {
  it("sets, clears and keeps untouched answers; never mutates the input", () => {
    const doc = Object.freeze({ [F.tick.id]: true, [F.short.id]: "16x25" });
    const r = applyChanges(FIELDS, doc, { [F.short.id]: null, [F.num.id]: 118 });
    expect(r).toEqual({ ok: true, values: { [F.tick.id]: true, [F.num.id]: 118 } });
    expect(doc).toEqual({ [F.tick.id]: true, [F.short.id]: "16x25" });
  });

  it("refuses unknown keys, heading keys and bad values with their ids", () => {
    expect(applyChanges(FIELDS, {}, { f_9999999999: true, [F.head.id]: "x", [F.num.id]: "12" })).toEqual({
      ok: false, fieldIds: ["f_9999999999", F.head.id, F.num.id],
    });
  });
});

describe("the 128 KB measure", () => {
  it("counts UTF-8 bytes of JSON.stringify, so multibyte and emoji weigh more than their length", () => {
    expect(valuesBytes({ a: "é" })).toBe(JSON.stringify({ a: "x" }).length + 1);
    expect(valuesBytes({ a: "😀" })).toBe(JSON.stringify({ a: "x" }).length + 3);
    // A tab is escaped by JSON.stringify: {"a":"\t"} is 10 bytes.
    expect(valuesBytes({ a: "\t" })).toBe(10);
  });

  it("the cap is unreachable with a valid definition: the largest valid document is measured well under it", () => {
    // 10 long answers (the most a form may hold) + 50 short answers, every one at its length limit in "€"
    // (3 UTF-8 bytes per UTF-16 unit, the worst a valid text can do; JSON escapes cost at most 2).
    const fields: FormField[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `f_long${String(i).padStart(6, "0")}`, type: "long_text" as const, label: "L", required: false })),
      ...Array.from({ length: 50 }, (_, i) => ({ id: `f_shrt${String(i).padStart(6, "0")}`, type: "short_text" as const, label: "S", required: false })),
    ];
    expect(formFieldsSchema.safeParse(fields).success).toBe(true);
    const values = Object.fromEntries(fields.map((f) => [f.id, "€".repeat(f.type === "long_text" ? FORM_LIMITS.longText : FORM_LIMITS.shortText)]));
    expect(fields.every((f) => draftValueOk(f, values[f.id]))).toBe(true);
    expect(valuesBytes(values)).toBe(91_081);
    expect(valuesTooLarge(values)).toBe(false);
  });

  it("refuses just over the cap and accepts at it", () => {
    const pad = (n: number) => ({ a: "x".repeat(n) });
    const overhead = valuesBytes(pad(0));
    expect(valuesTooLarge(pad(128 * 1024 - overhead))).toBe(false);
    expect(valuesTooLarge(pad(128 * 1024 - overhead + 1))).toBe(true);
    expect(valuesTooLarge({ a: "€".repeat(44_000) })).toBe(true);
  });
});

describe("missingRequired", () => {
  it("an unticked checkbox and an absent number are missing; N/A satisfies", () => {
    expect(missingRequired(FIELDS, { [F.yn.id]: "na" })).toEqual([F.tick.id, F.num.id]);
    expect(missingRequired(FIELDS, { [F.tick.id]: true, [F.yn.id]: "no", [F.num.id]: 300 })).toEqual([]);
  });
});

describe("carryValues", () => {
  it("drops answers whose field or option is gone, keeps the rest", () => {
    const v2: FormField[] = [F.tick, { ...F.choice, options: [{ id: "o_bbbbbbbb", label: "Dirty" }, { id: "o_cccccccc", label: "Missing" }] }];
    const before = { [F.tick.id]: true, [F.choice.id]: "o_aaaaaaaa", [F.short.id]: "16x25" } as const;
    const after = carryValues(v2, before);
    expect(after).toEqual({ [F.tick.id]: true });
    expect(droppedByCarry(before, after)).toEqual([F.choice.id, F.short.id]);
  });
});

describe("mergeDraft (spec §7.3)", () => {
  it("touched fields win, others take theirs; banner only for a foreign change", () => {
    const base = { a: true, b: "x" } as const;
    const theirs = { a: true, b: "y", c: 5 } as const;
    expect(mergeDraft(base, { a: null }, theirs)).toEqual({ values: { b: "y", c: 5 }, foreignChange: true });
  });

  it("a retry of my own landed write finds no foreign change", () => {
    const base = { a: true } as const;
    expect(mergeDraft(base, { b: "mine" }, { a: true, b: "mine" })).toEqual({ values: { a: true, b: "mine" }, foreignChange: false });
  });

  it("FORM_CHANGED path: carry both sides, then merge, so a colleague's answers survive", () => {
    const v2: FormField[] = [F.tick, F.short];
    const base = carryValues(v2, {});
    const mine = carryValues(v2, { [F.short.id]: "16x25", [F.num.id]: 118 });
    const theirs = { [F.tick.id]: true } as const;
    const m = mergeDraft(base, mine as Record<string, string>, theirs);
    expect(m.values).toEqual({ [F.tick.id]: true, [F.short.id]: "16x25" });
    expect(m.foreignChange).toBe(true);
  });
});

describe("numberInputState", () => {
  it("parses plain and thousands-separated numbers", () => {
    expect(numberInputState("1,200")).toEqual({ kind: "value", value: 1200 });
    expect(numberInputState(" 12.5 ")).toEqual({ kind: "value", value: 12.5 });
    expect(numberInputState("-0")).toEqual({ kind: "value", value: 0 });
    expect(numberInputState(".5")).toEqual({ kind: "value", value: 0.5 });
  });
  it("partial prefixes", () => {
    for (const s of ["-", "12.", "-.", "1,", "1,2", "1,20", "12,345,"]) expect(numberInputState(s)).toEqual({ kind: "partial" });
  });
  it("invalid and out of bounds", () => {
    for (const s of ["1e3", "12.3456", "abc", "1,2345", "--1"]) expect(numberInputState(s)).toEqual({ kind: "invalid" });
    expect(numberInputState("2000000")).toEqual({ kind: "out_of_bounds" });
    expect(numberInputState("")).toEqual({ kind: "empty" });
  });
});

describe("answerText and rangeNote", () => {
  it("renders every type", () => {
    expect(answerText(F.tick, true)).toBe("Done");
    expect(answerText(F.tick, undefined)).toBe("Not done");
    expect(answerText(F.yn, "na")).toBe("N/A");
    expect(answerText(F.choice, "o_bbbbbbbb")).toBe("Dirty");
    expect(answerText(F.num, 118)).toBe("118 psi");
    expect(answerText(F.num, 1200.5)).toBe("1,200.5 psi · Outside the usual range (100–140 psi)");
    expect(answerText(F.short, undefined)).toBe("No answer");
    expect(answerText(F.head, undefined)).toBe("Outdoor unit");
  });
  it("one-bound and unit-less ranges", () => {
    const lo: FormField = { id: "f_0000000009", type: "number", label: "T", required: false, unit: "°F", usualMin: 5 };
    const hi: FormField = { id: "f_0000000010", type: "number", label: "T", required: false, unit: "°F", usualMax: 15 };
    const bare: FormField = { id: "f_0000000011", type: "number", label: "T", required: false, usualMin: 5, usualMax: 15 };
    expect(rangeNote(lo, 2)).toBe("Outside the usual range (at least 5 °F)");
    expect(rangeNote(hi, 20)).toBe("Outside the usual range (at most 15 °F)");
    expect(rangeNote(bare, 20)).toBe("Outside the usual range (5–15)");
    expect(rangeNote(bare, 10)).toBeNull();
  });
});
```

`src/lib/format/plural.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { plural } from "./plural";

describe("plural", () => {
  it("picks the singular for exactly one", () => {
    expect(plural(1, "question", "questions")).toBe("1 question");
    expect(plural(0, "question", "questions")).toBe("0 questions");
    expect(plural(2, "answer isn't a number", "answers aren't numbers")).toBe("2 answers aren't numbers");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/forms src/lib/format`
Expected: FAIL — cannot resolve `./form-schema`, `./form-values`, `./plural` (the Task 1 migration test still passes).

- [ ] **Step 3: Implement** — `src/lib/forms/form-schema.ts`:

```ts
/**
 * Form definitions (M3d spec §3.3): a flat list of fields, validated by zod.
 * Pure and client-safe: shared by the server writers, the office builder and
 * the technician fill page. Error details are paths only, never zod messages.
 */
import { z } from "zod";

export const FIELD_TYPES = ["checkbox", "yes_no", "short_text", "long_text", "number", "choice", "heading"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_ID_RE = /^f_[a-z0-9]{10}$/;
export const OPTION_ID_RE = /^o_[a-z0-9]{8}$/;

export const FORM_LIMITS = {
  name: 80,
  description: 300,
  label: 120,
  help: 200,
  unit: 12,
  optionLabel: 60,
  minOptions: 2,
  maxOptions: 12,
  maxFields: 60,
  maxLongText: 10,
  definitionBytes: 64 * 1024,
  shortText: 200,
  longText: 2000,
  numberBound: 1_000_000,
  valuesBytes: 128 * 1024,
  maxForms: 100,
} as const;

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
}

interface FieldBase {
  readonly id: string;
  readonly label: string;
  readonly help?: string;
  readonly required: boolean;
}

export type FormField =
  | (FieldBase & { readonly type: "checkbox" })
  | (FieldBase & { readonly type: "yes_no"; readonly allowNa?: boolean })
  | (FieldBase & { readonly type: "short_text" })
  | (FieldBase & { readonly type: "long_text" })
  | (FieldBase & { readonly type: "number"; readonly unit?: string; readonly usualMin?: number; readonly usualMax?: number })
  | (FieldBase & { readonly type: "choice"; readonly options: readonly ChoiceOption[] })
  | (FieldBase & { readonly type: "heading" });

/** UTF-8 byte length (the caps are measured in bytes, not UTF-16 units). */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Finite, |x| < 1,000,000, at most 3 decimal places. */
export function isFormNumber(x: unknown): x is number {
  if (typeof x !== "number" || !Number.isFinite(x)) return false;
  if (Math.abs(x) >= FORM_LIMITS.numberBound) return false;
  return /^-?\d+(\.\d{1,3})?$/.test(String(x));
}

const label = z.string().trim().min(1).max(FORM_LIMITS.label);
const help = z.string().trim().max(FORM_LIMITS.help).optional();
const base = { id: z.string().regex(FIELD_ID_RE), label, help, required: z.boolean() };
const formNumber = z.number().refine(isFormNumber);

const fieldSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("checkbox") }).strict(),
  z.object({ ...base, type: z.literal("yes_no"), allowNa: z.boolean().optional() }).strict(),
  z.object({ ...base, type: z.literal("short_text") }).strict(),
  z.object({ ...base, type: z.literal("long_text") }).strict(),
  z.object({
    ...base,
    type: z.literal("number"),
    unit: z.string().trim().min(1).max(FORM_LIMITS.unit).optional(),
    usualMin: formNumber.optional(),
    usualMax: formNumber.optional(),
  }).strict(),
  z.object({
    ...base,
    type: z.literal("choice"),
    options: z
      .array(z.object({ id: z.string().regex(OPTION_ID_RE), label: z.string().trim().min(1).max(FORM_LIMITS.optionLabel) }).strict())
      .min(FORM_LIMITS.minOptions)
      .max(FORM_LIMITS.maxOptions),
  }).strict(),
  z.object({ ...base, type: z.literal("heading") }).strict(),
]);

/** The cross-field rules zod's per-field schemas can't see. */
export const formFieldsSchema = z.array(fieldSchema).superRefine((fields, ctx) => {
  if (fields.length < 1 || fields.length > FORM_LIMITS.maxFields) ctx.addIssue({ code: "custom", path: [], message: "count" });
  if (!fields.some((f) => f.type !== "heading")) ctx.addIssue({ code: "custom", path: [], message: "no_question" });
  if (fields.filter((f) => f.type === "long_text").length > FORM_LIMITS.maxLongText) {
    ctx.addIssue({ code: "custom", path: [], message: "long_text" });
  }
  const ids = new Set<string>();
  fields.forEach((f, i) => {
    if (ids.has(f.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: "duplicate_id" });
    ids.add(f.id);
    if (f.type === "heading" && f.required) ctx.addIssue({ code: "custom", path: [i, "required"], message: "heading_required" });
    if (f.type === "choice") {
      const optionIds = new Set(f.options.map((o) => o.id));
      const labels = new Set(f.options.map((o) => o.label.toLowerCase()));
      if (optionIds.size !== f.options.length || labels.size !== f.options.length) {
        ctx.addIssue({ code: "custom", path: [i, "options"], message: "duplicate_option" });
      }
    }
    if (f.type === "number" && f.usualMin !== undefined && f.usualMax !== undefined && f.usualMin > f.usualMax) {
      ctx.addIssue({ code: "custom", path: [i, "usualMax"], message: "range" });
    }
  });
  if (utf8Bytes(JSON.stringify(fields)) > FORM_LIMITS.definitionBytes) ctx.addIssue({ code: "custom", path: [], message: "size" });
});

export const formDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(FORM_LIMITS.name),
  description: z.string().trim().max(FORM_LIMITS.description).nullable(),
  jobTypeIds: z.array(z.string().uuid()).max(100),
  required: z.boolean(),
  fields: formFieldsSchema,
}).strict();

/** What a saved form holds (the parsed body is assignable to it). */
export interface FormDefinition {
  readonly name: string;
  readonly description: string | null;
  readonly jobTypeIds: readonly string[];
  readonly required: boolean;
  readonly fields: readonly FormField[];
}

/** First issue's path for a 400 `{ path }` detail (never the zod message). */
export function firstIssuePath(error: z.ZodError): (string | number)[] {
  const path = error.issues[0]?.path ?? [];
  return path.filter((p): p is string | number => typeof p === "string" || typeof p === "number");
}

/** Parse stored jsonb back into fields; anything malformed yields null (render nothing, never throw). */
export function parseStoredFields(raw: unknown): readonly FormField[] | null {
  const r = z.array(fieldSchema).safeParse(raw);
  return r.success ? (r.data as readonly FormField[]) : null;
}

export const questionCount = (fields: readonly FormField[]): number => fields.filter((f) => f.type !== "heading").length;
```

`src/lib/forms/form-values.ts`:

```ts
/**
 * Answer values (M3d spec §3.3, §4.2, §4.4, §7.3): draft and submit validation,
 * the changes document, the 128 KB measure, the three-way merge, carry across
 * a form version, and the read-only answer text. Pure and client-safe.
 */
import { FORM_LIMITS, isFormNumber, utf8Bytes, type FormField } from "./form-schema";

export type FieldValue = true | string | number;
export type FormValues = Readonly<Record<string, FieldValue>>;
/** A draft PUT body's `changes`: every touched field, `null` = cleared. */
export type Changes = Readonly<Record<string, FieldValue | null>>;

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const CONTROL_RE_G = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** C0 controls other than tab, LF and CR. */
export const hasControlChars = (s: string): boolean => CONTROL_RE.test(s);
/** What the client does on input. */
export const stripControlChars = (s: string): string => s.replace(CONTROL_RE_G, "");

function textOk(v: unknown, max: number): boolean {
  return typeof v === "string" && v.length >= 1 && v.length <= max && !hasControlChars(v);
}

/** Type and parse only (no required, no range). `null` = cleared and is valid for any question. */
export function draftValueOk(field: FormField, value: unknown): boolean {
  if (field.type === "heading") return false;
  if (value === null) return true;
  switch (field.type) {
    case "checkbox":
      return value === true;
    case "yes_no":
      return value === "yes" || value === "no" || (value === "na" && field.allowNa === true);
    case "short_text":
      return textOk(value, FORM_LIMITS.shortText);
    case "long_text":
      return textOk(value, FORM_LIMITS.longText);
    case "number":
      return isFormNumber(value);
    case "choice":
      return typeof value === "string" && field.options.some((o) => o.id === value);
  }
}

export type ApplyResult = { ok: true; values: FormValues } | { ok: false; fieldIds: string[] };

/** Apply `changes` to `doc` against the snapshot `fields`; any bad key or value refuses the whole write. */
export function applyChanges(fields: readonly FormField[], doc: FormValues, changes: Changes): ApplyResult {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const bad = Object.entries(changes)
    .filter(([id, v]) => {
      const f = byId.get(id);
      return f === undefined || !draftValueOk(f, v);
    })
    .map(([id]) => id);
  if (bad.length > 0) return { ok: false, fieldIds: bad };
  const out: Record<string, FieldValue> = { ...doc };
  for (const [id, v] of Object.entries(changes)) {
    if (v === null) delete out[id];
    else out[id] = v;
  }
  return { ok: true, values: out };
}

/** UTF-8 bytes of JSON.stringify(values), measured the same on both sides. */
export const valuesBytes = (values: FormValues): number => utf8Bytes(JSON.stringify(values));
export const valuesTooLarge = (values: FormValues): boolean => valuesBytes(values) > FORM_LIMITS.valuesBytes;

export function isAnswered(field: FormField, value: FieldValue | undefined): boolean {
  if (field.type === "heading") return true;
  if (field.type === "checkbox") return value === true;
  return value !== undefined;
}

/** Required questions without an answer (`na` satisfies a yes / no). */
export function missingRequired(fields: readonly FormField[], values: FormValues): string[] {
  return fields.filter((f) => f.type !== "heading" && f.required && !isAnswered(f, values[f.id])).map((f) => f.id);
}

/** Keep only the answers that are still valid against `fields` (a new form version). */
export function carryValues(fields: readonly FormField[], values: FormValues): FormValues {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return Object.fromEntries(Object.entries(values).filter(([id, v]) => {
    const f = byId.get(id);
    return f !== undefined && draftValueOk(f, v);
  }));
}

/** Answers the carry dropped, for "Not saved: …". */
export function droppedByCarry(before: FormValues, after: FormValues): string[] {
  return Object.keys(before).filter((id) => !(id in after));
}

/**
 * Three-way merge (spec §7.3): touched fields (`mine`) win, every other field
 * takes `theirs`. `foreignChange` = a field not touched here differs between
 * `base` and `theirs` (someone else changed it).
 */
export function mergeDraft(base: FormValues, mine: Changes, theirs: FormValues): { values: FormValues; foreignChange: boolean } {
  const out: Record<string, FieldValue> = { ...theirs };
  for (const [id, v] of Object.entries(mine)) {
    if (v === null) delete out[id];
    else out[id] = v;
  }
  const keys = new Set([...Object.keys(base), ...Object.keys(theirs)]);
  const foreignChange = [...keys].some((k) => !(k in mine) && base[k] !== theirs[k]);
  return { values: out, foreignChange };
}

export type NumberInputState =
  | { readonly kind: "empty" }
  | { readonly kind: "partial" }
  | { readonly kind: "invalid" }
  | { readonly kind: "out_of_bounds" }
  | { readonly kind: "value"; readonly value: number };

const THOUSANDS = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
const PARTIAL_DECIMAL = /^-?\d*\.$/;
const PARTIAL_THOUSANDS = /^-?\d{1,3}(,\d{3})*,\d{0,2}$/;
const PLAIN = /^-?(\d+(\.\d*)?|\.\d+)$/;

/** What a number input holds right now (spec §3.3). */
export function numberInputState(raw: string): NumberInputState {
  const s = raw.trim();
  if (s === "") return { kind: "empty" };
  if (s === "-" || PARTIAL_DECIMAL.test(s) || PARTIAL_THOUSANDS.test(s)) return { kind: "partial" };
  const plain = THOUSANDS.test(s) ? s.replace(/,/g, "") : s;
  if (!PLAIN.test(plain)) return { kind: "invalid" };
  const decimals = plain.includes(".") ? plain.split(".")[1]!.length : 0;
  if (decimals > 3) return { kind: "invalid" };
  const n = Number(plain);
  if (!Number.isFinite(n)) return { kind: "invalid" };
  if (Math.abs(n) >= FORM_LIMITS.numberBound) return { kind: "out_of_bounds" };
  return { kind: "value", value: n === 0 ? 0 : n };
}

const fmt = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 3 });
const withUnit = (n: number, unit: string | undefined): string => (unit ? `${fmt(n)} ${unit}` : fmt(n));

/** "Outside the usual range (5–15 °F)" / "(at least 5 °F)" / "(at most 15 °F)"; null when inside or unset. */
export function rangeNote(field: FormField, value: unknown): string | null {
  if (field.type !== "number" || typeof value !== "number") return null;
  const { usualMin: lo, usualMax: hi, unit } = field;
  if (lo === undefined && hi === undefined) return null;
  const below = lo !== undefined && value < lo;
  const above = hi !== undefined && value > hi;
  if (!below && !above) return null;
  const suffix = unit ? ` ${unit}` : "";
  if (lo !== undefined && hi !== undefined) return `Outside the usual range (${fmt(lo)}–${fmt(hi)}${suffix})`;
  if (lo !== undefined) return `Outside the usual range (at least ${fmt(lo)}${suffix})`;
  return `Outside the usual range (at most ${fmt(hi!)}${suffix})`;
}

/** One answer as read-only text (office section, read-only fill page, "Not saved" list). */
export function answerText(field: FormField, value: FieldValue | undefined): string {
  switch (field.type) {
    case "heading":
      return field.label;
    case "checkbox":
      return value === true ? "Done" : "Not done";
    case "yes_no":
      return value === "yes" ? "Yes" : value === "no" ? "No" : value === "na" ? "N/A" : "No answer";
    case "choice":
      return field.options.find((o) => o.id === value)?.label ?? "No answer";
    case "number": {
      if (typeof value !== "number") return "No answer";
      const note = rangeNote(field, value);
      return note ? `${withUnit(value, field.unit)} · ${note}` : withUnit(value, field.unit);
    }
    case "short_text":
    case "long_text":
      return typeof value === "string" ? value : "No answer";
  }
}
```

`src/lib/format/plural.ts`:

```ts
/** "1 question" / "3 questions". The one plural helper for M3d copy (spec §7). */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/forms src/lib/format`
Expected: PASS (form-schema 7, form-values 18, plural 1, migration 6).

- [ ] **Step 5: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/forms src/lib/format && npx vitest run
git add src/lib/forms/form-schema.ts src/lib/forms/form-schema.test.ts src/lib/forms/form-values.ts src/lib/forms/form-values.test.ts src/lib/format/plural.ts src/lib/format/plural.test.ts
git commit -m "$(cat <<'EOF'
feat(m3d): form field model, draft/submit validation, three-way merge, plural helper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 3: Shared primitives — `canonicalJson`, `macHex`, stored codes, gates and visit counts, site scope

**Files:**
- Create: `src/lib/forms/form-gates.ts`, `src/lib/forms/form-gates.test.ts`, `src/lib/forms/site-scope.ts`, `src/lib/forms/site-scope.test.ts`, `src/lib/tech/upload-limits.ts`, `src/lib/db/sql-arrays.ts`
- Modify: `src/lib/http/idempotency.ts` (`canonicalJson` exported, `officeId` kind `"form"`), `src/lib/http/idempotency.test.ts` (the `STORED_CODES` pin + new cases), `src/lib/http/idempotency-codes.ts`, `src/lib/crypto.ts` (`macHex`), `src/lib/crypto.test.ts`, `src/lib/admin/location-queries.ts` (`normalizeAddress` exported)

**Interfaces:**
- Consumes: `statusInSql` (`src/lib/admin/estimate-billing-sql.ts`), `BILL_STATUSES` (`src/lib/tech/field-sale-statuses.ts`).
- Produces:
  - `idempotency.ts`: `canonicalJson(value: unknown): string`; `canonicalHash` now hashes `canonicalJson(body)` (same output as before); `officeId(kind: "payment" | "refund" | "form", org, clientToken)`.
  - `crypto.ts`: `macHex(label: string, value: string): string` (HMAC-SHA256 hex, label NUL value, as `blindIndex`).
  - `idempotency-codes.ts`: `STORED_CODES` gains `FORM_SUBMITTED`, `FORM_INCOMPLETE`, `ANSWERS_REMOVED`, `CUSTOMER_REMOVED`, `ANSWERS_UNREADABLE`.
  - `form-gates.ts`: `visitGateSql(org, rid, aid, me)`, `requestGateSql(org, rid, aid, me)`, `formAppliesSql(f, r)` / `formApplies(jobTypeIds, jobTypeId)`, `visitCountsSql(org, p)` / `visitCounts(VisitFacts)`, `readFormGatesSql(org, rid, aid, me, formId | null)`, `interface FormGates`, `toFormGates(row)`, `type GateReason = "not_found" | "job_closed" | "visit_ended" | "not_assigned" | "not_on_site" | "customer_removed"`, `gateReason(g)`, `type WriteBlockedReason` (the spec's 10 values minus null), `interface RowFacts`, `writeBlockedReason(g, row)`.
  - `site-scope.ts`: `type SiteScope = "location" | "address" | "none"`, `SiteSelf`, `SiteCandidate`, `siteScopeOf(self)`, `siteMatches(self, candidates): string[]`, `membershipEvaluable(selfAddress, locationCount, allAddresses)`.
  - `location-queries.ts`: `normalizeAddress(addr)` exported (unchanged body).
  - `upload-limits.ts`: `TECH_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024`, `FILE_TOO_LARGE_COPY`.
  - `sql-arrays.ts`: `uuidArraySql(ids)` → `ARRAY[$1::uuid, …]::uuid[]`.

- [ ] **Step 1: Write the failing tests** — `src/lib/forms/form-gates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  formApplies, formAppliesSql, gateReason, readFormGatesSql, requestGateSql, toFormGates, visitCounts, visitCountsSql,
  visitGateSql, writeBlockedReason, type FormGates,
} from "./form-gates";

const ORG = "11111111-1111-4111-8111-111111111111";
const RID = "22222222-2222-4222-8222-222222222222";
const AID = "33333333-3333-4333-8333-333333333333";
const ME = "44444444-4444-4444-8444-444444444444";
const FORM = "55555555-5555-4555-8555-555555555555";
const dialect = new PgDialect();
const q = (s: SQL) => dialect.sqlToQuery(s);
const text = (s: SQL) => q(s).sql.replace(/\s+/g, " ").trim();
const orgCount = (s: SQL) => q(s).params.filter((p) => p === ORG).length;

describe("gate SQL (spec §5.1)", () => {
  it("visitGateSql joins on a.appointment_id = p.id and binds the org on both tables", () => {
    const s = visitGateSql(ORG, RID, AID, ME);
    expect(text(s)).toBe(
      "EXISTS (SELECT 1 FROM appointments p JOIN appointment_assignments a ON a.appointment_id = p.id WHERE p.id = $1::uuid AND p.service_request_id = $2::uuid AND p.organization_id = $3::uuid AND a.organization_id = $4::uuid AND p.cancelled_at IS NULL AND a.technician_id = $5::uuid AND a.status <> 'cancelled'::request_status)",
    );
    expect(orgCount(s)).toBe(2);
  });

  it("requestGateSql: not cancelled; synced OR on site OR own arrival (parenthesised); customer not erased", () => {
    const s = requestGateSql(ORG, RID, AID, ME);
    const t = text(s);
    expect(t).toContain("rg.status <> 'cancelled'::request_status");
    expect(t).toContain("AND ((rg.fieldpulse_job_id IS NOT NULL OR rg.hcp_job_id IS NOT NULL) OR rg.status IN ('arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status, 'completed'::request_status) OR EXISTS (SELECT 1 FROM appointment_assignments ga");
    expect(t).toContain("(ga.arrived_at IS NOT NULL OR ga.started_at IS NOT NULL OR ga.completed_at IS NOT NULL))");
    expect(t).toContain("NOT EXISTS (SELECT 1 FROM customers gc WHERE gc.id = rg.customer_id AND gc.organization_id = $");
    expect(t).toContain("gc.anonymized_at IS NOT NULL");
    expect(orgCount(s)).toBe(3);
  });

  it("formAppliesSql and its pure twin", () => {
    expect(text(formAppliesSql("f", "r"))).toBe("(cardinality(f.job_type_ids) = 0 OR r.job_type_id = ANY(f.job_type_ids))");
    expect(formApplies([], null)).toBe(true);
    expect(formApplies(["jt-1"], null)).toBe(false);
    expect(formApplies(["jt-1"], "jt-1")).toBe(true);
  });

  it("visitCountsSql: live OR progressed/completed row OR a submission, org-bound twice", () => {
    const s = visitCountsSql(ORG, "p");
    const t = text(s);
    expect(t.startsWith("(p.cancelled_at IS NULL OR EXISTS (SELECT 1 FROM appointment_assignments vca WHERE vca.appointment_id = p.id")).toBe(true);
    expect(t).toContain("vca.status = 'completed'::request_status))");
    expect(t).toContain("OR EXISTS (SELECT 1 FROM form_submissions vcs WHERE vcs.appointment_id = p.id AND vcs.organization_id = $2::uuid))");
    expect(orgCount(s)).toBe(2);
  });

  it("readFormGatesSql reads the visit and the form org-scoped", () => {
    const s = readFormGatesSql(ORG, RID, AID, ME, FORM);
    const t = text(s);
    expect(t).toContain("LEFT JOIN appointments p ON p.id = $");
    expect(t).toContain("p.service_request_id = r.id AND p.organization_id = $");
    expect(t).toContain("LEFT JOIN forms f ON f.id = $");
    expect(t).toContain("WHERE r.id = $");
    expect(orgCount(s)).toBe(7);
    expect(q(readFormGatesSql(ORG, RID, AID, ME, null)).params).toContain(null);
  });
});

describe("visitCounts", () => {
  const a = (progressed: boolean, status = "assigned") => ({ progressed, status });
  it("live; ended by a hold with progress; with a submission; cancelled untouched", () => {
    expect(visitCounts({ cancelledAt: null, assignments: [], hasSubmission: false })).toBe(true);
    expect(visitCounts({ cancelledAt: new Date(), assignments: [a(true, "cancelled")], hasSubmission: false })).toBe(true);
    expect(visitCounts({ cancelledAt: new Date(), assignments: [a(false, "completed")], hasSubmission: false })).toBe(true);
    expect(visitCounts({ cancelledAt: new Date(), assignments: [a(false, "cancelled")], hasSubmission: true })).toBe(true);
    expect(visitCounts({ cancelledAt: new Date(), assignments: [a(false, "cancelled")], hasSubmission: false })).toBe(false);
  });
});

const ok: FormGates = {
  status: "arrived", native: true, customerErased: false, visitFound: true, visitLive: true,
  myRow: true, myLiveRow: true, myProgress: false, formFound: true, formActive: true, formVersion: 1,
};

describe("gateReason (lead ruling 1)", () => {
  it("passes an on-site native job and any synced status but cancelled", () => {
    expect(gateReason(ok)).toBeNull();
    expect(gateReason({ ...ok, native: false, status: "scheduled" })).toBeNull();
    expect(gateReason({ ...ok, status: "completed" })).toBeNull();
  });
  it("a native helper who arrived before the request did is allowed; without progress → not_on_site", () => {
    expect(gateReason({ ...ok, status: "scheduled", myProgress: true })).toBeNull();
    expect(gateReason({ ...ok, status: "scheduled" })).toBe("not_on_site");
  });
  it("orders job_closed, customer_removed, visit_ended / not_assigned, not_on_site", () => {
    expect(gateReason(null)).toBe("not_found");
    expect(gateReason({ ...ok, visitFound: false })).toBe("not_found");
    expect(gateReason({ ...ok, status: "cancelled", visitLive: false, myLiveRow: false })).toBe("job_closed");
    expect(gateReason({ ...ok, native: false, status: "cancelled" })).toBe("job_closed");
    expect(gateReason({ ...ok, visitLive: false })).toBe("visit_ended");
    expect(gateReason({ ...ok, visitLive: false, myRow: false, myLiveRow: false })).toBe("not_assigned");
    expect(gateReason({ ...ok, myLiveRow: false })).toBe("not_assigned");
    expect(gateReason({ ...ok, customerErased: true })).toBe("customer_removed");
    // An erased customer refuses before the on-site and visit checks (the GET shows the same reason).
    expect(gateReason({ ...ok, customerErased: true, status: "scheduled" })).toBe("customer_removed");
    expect(gateReason({ ...ok, customerErased: true, visitLive: false })).toBe("customer_removed");
    expect(gateReason({ ...ok, customerErased: true, status: "cancelled" })).toBe("job_closed");
  });
  it("toFormGates maps the row and treats nulls as false", () => {
    expect(toFormGates(undefined)).toBeNull();
    expect(toFormGates({ status: "arrived", native: true, visit_found: true, visit_live: null, form_version: "3" })).toMatchObject({
      visitLive: false, formVersion: 3, myRow: false,
    });
  });
});

describe("writeBlockedReason (spec §6)", () => {
  const draft = { status: "draft" as const, erased: false, unreadable: false };
  it("null when the caller may write", () => {
    expect(writeBlockedReason(ok, null)).toBeNull();
    expect(writeBlockedReason(ok, draft)).toBeNull();
  });
  it("row states before gates; archived only without a row", () => {
    expect(writeBlockedReason(ok, { ...draft, erased: true })).toBe("answers_removed");
    expect(writeBlockedReason({ ...ok, customerErased: true }, draft)).toBe("customer_removed");
    expect(writeBlockedReason(ok, { ...draft, status: "submitted" })).toBe("submitted");
    expect(writeBlockedReason(ok, { ...draft, unreadable: true })).toBe("unreadable");
    expect(writeBlockedReason({ ...ok, formActive: false }, null)).toBe("archived");
    expect(writeBlockedReason({ ...ok, formActive: false }, draft)).toBeNull();
  });
  it("gates map to their reasons", () => {
    expect(writeBlockedReason({ ...ok, status: "cancelled" }, draft)).toBe("job_closed");
    expect(writeBlockedReason({ ...ok, visitLive: false }, draft)).toBe("visit_ended");
    expect(writeBlockedReason({ ...ok, myRow: false, myLiveRow: false }, null)).toBe("not_assigned");
    expect(writeBlockedReason({ ...ok, status: "scheduled" }, null)).toBe("not_on_site");
  });
});
```

`src/lib/forms/site-scope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { membershipEvaluable, siteMatches, siteScopeOf, type SiteCandidate, type SiteSelf } from "./site-scope";

const L1 = "loc-1";
const L2 = "loc-2";
const A = "12 elm st, johnson city, tn";
const B = "40 oak ave, johnson city, tn";
const self = (over: Partial<SiteSelf> = {}): SiteSelf => ({ hasCustomer: true, customerErased: false, locationId: null, address: null, ...over });
const c = (id: string, locationId: string | null, address: string | null): SiteCandidate => ({ id, locationId, address });

describe("siteScopeOf / siteMatches (spec §7.6)", () => {
  const candidates = [c("same-loc", L1, B), c("other-loc", L2, A), c("no-loc-same-addr", null, A), c("no-loc-other", null, B), c("bare", null, null)];

  it("location: same location, plus location-less requests at the same address", () => {
    const s = self({ locationId: L1, address: A });
    expect(siteScopeOf(s)).toBe("location");
    expect(siteMatches(s, candidates)).toEqual(["same-loc", "no-loc-same-addr"]);
  });

  it("location with no address of its own: only the same location", () => {
    expect(siteMatches(self({ locationId: L1 }), candidates)).toEqual(["same-loc"]);
  });

  it("address: an equal normalised address, whatever the candidate's location", () => {
    const s = self({ address: A });
    expect(siteScopeOf(s)).toBe("address");
    expect(siteMatches(s, candidates)).toEqual(["other-loc", "no-loc-same-addr"]);
  });

  it("none: no location and no address, no customer, or an erased customer; no fallback", () => {
    expect(siteScopeOf(self())).toBe("none");
    expect(siteMatches(self(), candidates)).toEqual([]);
    expect(siteScopeOf(self({ hasCustomer: false, address: A }))).toBe("none");
    expect(siteMatches(self({ customerErased: true, locationId: L1, address: A }), candidates)).toEqual([]);
  });

  it("an address-less, location-less candidate never matches", () => {
    expect(siteMatches(self({ address: A }), [c("bare", null, null)])).toEqual([]);
  });
});

describe("membershipEvaluable", () => {
  it("one address everywhere and at most one location", () => {
    expect(membershipEvaluable(A, 1, [A, A])).toBe(true);
    expect(membershipEvaluable(A, 0, [A])).toBe(true);
  });
  it("withheld for a second location, an address-less sibling or a different address", () => {
    expect(membershipEvaluable(A, 2, [A])).toBe(false);
    expect(membershipEvaluable(A, 1, [A, null])).toBe(false);
    expect(membershipEvaluable(A, 1, [A, B])).toBe(false);
    expect(membershipEvaluable(null, 0, [null])).toBe(false);
  });
});
```

Extend `src/lib/http/idempotency.test.ts` and `src/lib/crypto.test.ts`:

```diff
diff --git a/src/lib/http/idempotency.test.ts b/src/lib/http/idempotency.test.ts
index a291c3f..ba6e7f7 100644
--- a/src/lib/http/idempotency.test.ts
+++ b/src/lib/http/idempotency.test.ts
@@ -11,6 +11,7 @@ import {
   M3B_NAMESPACE,
   parseIdempotencyKey,
   canonicalHash,
+  canonicalJson,
   multipartHash,
   derivedIdInput,
   derivedId,
@@ -460,7 +461,7 @@ describe("toResponse", () => {
 describe("idempotency-codes", () => {
   it("STORED_CODES is exactly the deterministic set, shared with the client", () => {
     expect([...STORED_CODES].sort()).toEqual(
-      ["ALREADY_BILLED", "ALREADY_DECIDED", "EQUIPMENT_RETIRED", "ESTIMATE_EXPIRED", "INVALID_INPUT", "INVALID_OPTION", "INVOICE_CHANGED", "INVOICE_LOCKED", "INVOICE_VOIDED", "ITEM_NOT_FOUND", "NO_LINES", "SEND_FAILED", "VALIDATION_ERROR"],
+      ["ALREADY_BILLED", "ALREADY_DECIDED", "ANSWERS_REMOVED", "ANSWERS_UNREADABLE", "CUSTOMER_REMOVED", "EQUIPMENT_RETIRED", "ESTIMATE_EXPIRED", "FORM_INCOMPLETE", "FORM_SUBMITTED", "INVALID_INPUT", "INVALID_OPTION", "INVOICE_CHANGED", "INVOICE_LOCKED", "INVOICE_VOIDED", "ITEM_NOT_FOUND", "NO_LINES", "SEND_FAILED", "VALIDATION_ERROR"],
     );
     expect(CLIENT_SPENT_CODES).toBe(STORED_CODES);
   });
@@ -514,3 +515,16 @@ describe("tech derived ids vs office ids (no collision)", () => {
     expect(officeId("payment", ORG, TOKEN)).toBe(officeId("payment", ORG, TOKEN));
   });
 });
+
+describe("canonicalJson (M3d)", () => {
+  it("sorts keys recursively, drops undefined, keeps array order; canonicalHash hashes it", () => {
+    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: undefined } })).toBe('{"a":{"d":[3,1]},"b":1}');
+    expect(canonicalJson(undefined)).toBe("{}");
+    expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }));
+  });
+  it("officeId takes the form kind and differs from the payment kind", () => {
+    const ORG = "11111111-1111-4111-8111-111111111111";
+    const TOKEN = "22222222-2222-4222-8222-222222222222";
+    expect(officeId("form", ORG, TOKEN)).not.toBe(officeId("payment", ORG, TOKEN));
+  });
+});
```

```diff
diff --git a/src/lib/crypto.test.ts b/src/lib/crypto.test.ts
index 5d296d8..8a5732c 100644
--- a/src/lib/crypto.test.ts
+++ b/src/lib/crypto.test.ts
@@ -5,6 +5,7 @@ import {
   encryptFields,
   decryptFields,
   blindIndex,
+  macHex,
 } from '@/lib/crypto';
 
 const TEST_KEY = 'a'.repeat(64); // 64 hex chars = 32 bytes
@@ -180,3 +181,12 @@ describe('encryptFields / decryptFields', () => {
     expect(encrypted.email).not.toBe('test@test.com');
   });
 });
+
+describe('macHex (M3d)', () => {
+  it('is blindIndex under the blind-index label, and a different label gives a different digest', () => {
+    expect(macHex('hvac-blind-index-v1', 'pat@example.com')).toBe(blindIndex('pat@example.com'));
+    expect(macHex('hvac-form-changes-v1', 'pat@example.com')).not.toBe(blindIndex('pat@example.com'));
+    expect(macHex('hvac-form-changes-v1', '{}')).toMatch(/^[0-9a-f]{64}$/);
+    expect(macHex('hvac-form-changes-v1', '')).toMatch(/^[0-9a-f]{64}$/);
+  });
+});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/forms src/lib/http/idempotency.test.ts src/lib/crypto.test.ts`
Expected: FAIL — `./form-gates` and `./site-scope` unresolved; `canonicalJson` / `macHex` not exported; the `STORED_CODES` list differs.

- [ ] **Step 3: Implement.** Edits to existing files:

```diff
diff --git a/src/lib/http/idempotency.ts b/src/lib/http/idempotency.ts
index c5213af..806aa5b 100644
--- a/src/lib/http/idempotency.ts
+++ b/src/lib/http/idempotency.ts
@@ -65,9 +65,14 @@ function canonical(value: unknown): unknown {
 
 const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
 
+/** The canonical JSON text: object keys sorted recursively, undefined dropped, arrays in order; null/undefined → "{}". */
+export function canonicalJson(value: unknown): string {
+  return JSON.stringify(canonical(value ?? {}));
+}
+
 /** sha256 hex of the canonical JSON; null/undefined/empty bodies hash "{}". */
 export function canonicalHash(body: unknown): string {
-  return sha256Hex(JSON.stringify(canonical(body ?? {})));
+  return sha256Hex(canonicalJson(body));
 }
 
 export function multipartHash(p: { route: string; requestId: string; fileSha256: string; name: string }): string {
@@ -86,7 +91,7 @@ export function materialLineId(invoiceId: string, jobMaterialId: string): string
   return uuidv5(`${invoiceId}|material|${jobMaterialId}`, M3B_NAMESPACE);
 }
 
-export function officeId(kind: "payment" | "refund", organizationId: string, clientToken: string): string {
+export function officeId(kind: "payment" | "refund" | "form", organizationId: string, clientToken: string): string {
   return uuidv5(`${organizationId}|${kind}|${clientToken}`, M3B_NAMESPACE);
 }
 
```

```diff
diff --git a/src/lib/http/idempotency-codes.ts b/src/lib/http/idempotency-codes.ts
index 9f4ac5c..0d2c814 100644
--- a/src/lib/http/idempotency-codes.ts
+++ b/src/lib/http/idempotency-codes.ts
@@ -9,7 +9,7 @@
  * SEND_FAILED is stored because a pay-link message may already have gone out.
  * M3c adds the estimate and equipment terminal codes (spec §4) and INVOICE_CHANGED
  * (plan ruling 11: the bill's derived invoice was paid or voided, so the next try
- * needs a new key). */
+ * needs a new key). M3d adds the form-submit terminal codes. */
 export const STORED_CODES: ReadonlySet<string> = new Set([
   "INVOICE_LOCKED",
   "NO_LINES",
@@ -24,6 +24,12 @@ export const STORED_CODES: ReadonlySet<string> = new Set([
   "INVALID_OPTION",
   "EQUIPMENT_RETIRED",
   "INVOICE_CHANGED",
+  // M3d form submit (spec §4.3): terminal for this body; a new tap mints a new key.
+  "FORM_SUBMITTED",
+  "FORM_INCOMPLETE",
+  "ANSWERS_REMOVED",
+  "CUSTOMER_REMOVED",
+  "ANSWERS_UNREADABLE",
 ]);
 
 /** On the client a stored code means "this key is spent": mint a new one. */
```

```diff
diff --git a/src/lib/crypto.ts b/src/lib/crypto.ts
index 4024e2b..22f5f70 100644
--- a/src/lib/crypto.ts
+++ b/src/lib/crypto.ts
@@ -102,6 +102,21 @@ export function blindIndex(normalizedValue: string): string {
     .digest("hex");
 }
 
+/**
+ * HMAC-SHA256 hex under ENCRYPTION_KEY, domain-separated by `label` exactly as
+ * `blindIndex` is by "hvac-blind-index-v1" (label, NUL, value). M3d hashes a
+ * form submit's answers with "hvac-form-changes-v1" so the stored request hash
+ * can't be dictionary-attacked back to answers and never shares the contact
+ * blind-index domain. Unlike blindIndex it takes any string, empty included.
+ */
+export function macHex(label: string, value: string): string {
+  return createHmac("sha256", getEncryptionKey())
+    .update(label)
+    .update("\0")
+    .update(value)
+    .digest("hex");
+}
+
 /**
  * Encrypts specified string fields on an object, returning a new object (immutable).
  * Non-string or empty fields are left unchanged.
```

```diff
diff --git a/src/lib/admin/location-queries.ts b/src/lib/admin/location-queries.ts
index 89042b2..e21f71d 100644
--- a/src/lib/admin/location-queries.ts
+++ b/src/lib/admin/location-queries.ts
@@ -12,7 +12,7 @@ import { isUniqueViolation } from "@/lib/db/unique-violation";
 import { encrypt, decrypt, blindIndex } from "@/lib/crypto";
 
 /** Normalize an address string for blind-index matching (case/space-insensitive). */
-function normalizeAddress(addr: string): string {
+export function normalizeAddress(addr: string): string {
   return addr.trim().toLowerCase().replace(/\s+/g, " ");
 }
 
```

New files — `src/lib/forms/form-gates.ts`:

```ts
/**
 * Who may fill a form, and when (M3d spec §5.1), as SQL for the writers and a
 * pure decision for the routes and GETs. Every table reference binds
 * organization_id; every fragment holding an OR is parenthesised. No db import.
 */
import { sql, type SQL } from "drizzle-orm";
import { statusInSql } from "@/lib/admin/estimate-billing-sql";
import { BILL_STATUSES } from "@/lib/tech/field-sale-statuses";

const BILL_IN = statusInSql(BILL_STATUSES);

/** The caller holds a non-cancelled assignment on THAT live visit of the request. */
export function visitGateSql(org: string, rid: string, aid: string, me: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointments p JOIN appointment_assignments a ON a.appointment_id = p.id
    WHERE p.id = ${aid}::uuid AND p.service_request_id = ${rid}::uuid AND p.organization_id = ${org}::uuid AND a.organization_id = ${org}::uuid
      AND p.cancelled_at IS NULL AND a.technician_id = ${me}::uuid AND a.status <> 'cancelled'::request_status)`;
}

/** The caller's own row on the visit has arrived / started / completed (the helper arm). */
function ownProgressSql(org: string, aid: string, me: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointment_assignments ga WHERE ga.appointment_id = ${aid}::uuid AND ga.organization_id = ${org}::uuid
      AND ga.technician_id = ${me}::uuid AND (ga.arrived_at IS NOT NULL OR ga.started_at IS NOT NULL OR ga.completed_at IS NOT NULL))`;
}

/**
 * The request is in the org and not cancelled; native: on site (BILL_STATUSES)
 * or the caller's own row has arrived; synced (FieldPulse or HCP): any status
 * but cancelled; and its customer is not erased.
 */
export function requestGateSql(org: string, rid: string, aid: string, me: string): SQL {
  return sql`EXISTS (SELECT 1 FROM service_requests rg WHERE rg.id = ${rid}::uuid AND rg.organization_id = ${org}::uuid
      AND rg.status <> 'cancelled'::request_status
      AND ((rg.fieldpulse_job_id IS NOT NULL OR rg.hcp_job_id IS NOT NULL) OR rg.status IN ${BILL_IN} OR ${ownProgressSql(org, aid, me)})
      AND NOT EXISTS (SELECT 1 FROM customers gc WHERE gc.id = rg.customer_id AND gc.organization_id = ${org}::uuid AND gc.anonymized_at IS NOT NULL))`;
}

/** Empty job_type_ids = every request; a NULL job_type_id gets only those. Aliases are trusted literals. */
export function formAppliesSql(f: string, r: string): SQL {
  return sql.raw(`(cardinality(${f}.job_type_ids) = 0 OR ${r}.job_type_id = ANY(${f}.job_type_ids))`);
}

/** Pure twin of formAppliesSql. */
export function formApplies(jobTypeIds: readonly string[], jobTypeId: string | null): boolean {
  return jobTypeIds.length === 0 || (jobTypeId !== null && jobTypeIds.includes(jobTypeId));
}

/**
 * "Visit counts" (spec §5.1): live, or work progressed / completed on it, or it
 * holds a submission. Governs reads, submittedOn, links, missingRequired and
 * the office label; writes still need a live visit. `p` is the visit alias.
 */
export function visitCountsSql(org: string, p: string): SQL {
  const v = sql.raw(p);
  return sql`(${v}.cancelled_at IS NULL
    OR EXISTS (SELECT 1 FROM appointment_assignments vca WHERE vca.appointment_id = ${v}.id AND vca.organization_id = ${org}::uuid
      AND (vca.en_route_at IS NOT NULL OR vca.arrived_at IS NOT NULL OR vca.started_at IS NOT NULL OR vca.completed_at IS NOT NULL OR vca.status = 'completed'::request_status))
    OR EXISTS (SELECT 1 FROM form_submissions vcs WHERE vcs.appointment_id = ${v}.id AND vcs.organization_id = ${org}::uuid))`;
}

export interface VisitFacts {
  readonly cancelledAt: Date | string | null;
  readonly assignments: ReadonlyArray<{ readonly progressed: boolean; readonly status: string }>;
  readonly hasSubmission: boolean;
}

/** Pure twin of visitCountsSql. */
export function visitCounts(v: VisitFacts): boolean {
  return v.cancelledAt === null || v.hasSubmission || v.assignments.some((a) => a.progressed || a.status === "completed");
}

/** Everything the gate decisions read, in one row (spec §5.1). `formId` null reads no form. */
export function readFormGatesSql(org: string, rid: string, aid: string, me: string, formId: string | null): SQL {
  const mine = sql`SELECT 1 FROM appointment_assignments a WHERE a.appointment_id = p.id AND a.organization_id = ${org}::uuid AND a.technician_id = ${me}::uuid`;
  return sql`SELECT r.status::text AS status,
      (r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL) AS native,
      EXISTS (SELECT 1 FROM customers c WHERE c.id = r.customer_id AND c.organization_id = ${org}::uuid AND c.anonymized_at IS NOT NULL) AS customer_erased,
      p.id IS NOT NULL AS visit_found,
      COALESCE(p.cancelled_at IS NULL, false) AS visit_live,
      EXISTS (${mine}) AS my_row,
      EXISTS (${mine} AND a.status <> 'cancelled'::request_status) AS my_live_row,
      EXISTS (${mine} AND (a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL)) AS my_progress,
      f.id IS NOT NULL AS form_found,
      COALESCE(f.active, false) AS form_active,
      f.version AS form_version
    FROM service_requests r
    LEFT JOIN appointments p ON p.id = ${aid}::uuid AND p.service_request_id = r.id AND p.organization_id = ${org}::uuid
    LEFT JOIN forms f ON f.id = ${formId}::uuid AND f.organization_id = ${org}::uuid
    WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid`;
}

export interface FormGates {
  readonly status: string;
  readonly native: boolean;
  readonly customerErased: boolean;
  readonly visitFound: boolean;
  readonly visitLive: boolean;
  readonly myRow: boolean;
  readonly myLiveRow: boolean;
  readonly myProgress: boolean;
  readonly formFound: boolean;
  readonly formActive: boolean;
  readonly formVersion: number | null;
}

export function toFormGates(row: Record<string, unknown> | undefined): FormGates | null {
  if (!row) return null;
  return {
    status: String(row.status),
    native: row.native === true,
    customerErased: row.customer_erased === true,
    visitFound: row.visit_found === true,
    visitLive: row.visit_live === true,
    myRow: row.my_row === true,
    myLiveRow: row.my_live_row === true,
    myProgress: row.my_progress === true,
    formFound: row.form_found === true,
    formActive: row.form_active === true,
    formVersion: row.form_version == null ? null : Number(row.form_version),
  };
}

export type GateReason = "not_found" | "job_closed" | "visit_ended" | "not_assigned" | "not_on_site" | "customer_removed";

/**
 * The first failing write gate, or null (lead ruling 1): a cancelled request
 * reads JOB_CLOSED before its (cancelled) visits and rows; an erased customer
 * refuses every write next, whoever and wherever (the GET's reason then matches
 * the refusal); an ended visit reads VISIT_ENDED to a technician who was on it,
 * NOT_ASSIGNED to anyone else.
 */
export function gateReason(g: FormGates | null): GateReason | null {
  if (!g || !g.visitFound) return "not_found";
  if (g.status === "cancelled") return "job_closed";
  if (g.customerErased) return "customer_removed";
  if (!g.visitLive) return g.myRow ? "visit_ended" : "not_assigned";
  if (!g.myLiveRow) return "not_assigned";
  if (g.native && !(BILL_STATUSES as readonly string[]).includes(g.status) && !g.myProgress) return "not_on_site";
  return null;
}

export type WriteBlockedReason =
  | "not_assigned" | "visit_ended" | "not_on_site" | "job_closed" | "archived"
  | "answers_removed" | "customer_removed" | "unreadable" | "submitted";

export interface RowFacts {
  readonly status: "draft" | "submitted";
  readonly erased: boolean;
  readonly unreadable: boolean;
}

/** The GET's `writeBlockedReason` (spec §6): null = the caller may write. */
export function writeBlockedReason(g: FormGates, row: RowFacts | null): WriteBlockedReason | null {
  if (g.status === "cancelled") return "job_closed";
  if (row?.erased) return "answers_removed";
  if (g.customerErased) return "customer_removed";
  if (row?.status === "submitted") return "submitted";
  if (row?.unreadable) return "unreadable";
  const gate = gateReason(g);
  if (gate === "visit_ended" || gate === "not_assigned" || gate === "not_on_site") return gate;
  if (gate === "not_found") return "not_assigned";
  if (row === null && !g.formActive) return "archived";
  return null;
}
```

`src/lib/forms/site-scope.ts`:

```ts
/**
 * Site match (M3d spec §7.6), the pure decision over SQL reads. Addresses are
 * passed in already normalised (`normalizeAddress`, admin/location-queries).
 * Never another address of the customer; never a guessed address.
 */
export type SiteScope = "location" | "address" | "none";

export interface SiteSelf {
  readonly hasCustomer: boolean;
  readonly customerErased: boolean;
  readonly locationId: string | null;
  /** This request's normalised address, or null. */
  readonly address: string | null;
}

export interface SiteCandidate {
  readonly id: string;
  readonly locationId: string | null;
  readonly address: string | null;
}

export function siteScopeOf(self: SiteSelf): SiteScope {
  if (!self.hasCustomer || self.customerErased) return "none";
  if (self.locationId !== null) return "location";
  return self.address !== null ? "address" : "none";
}

/** The candidates (the customer's other non-cancelled requests) at this site, in input order. */
export function siteMatches(self: SiteSelf, candidates: readonly SiteCandidate[]): string[] {
  const scope = siteScopeOf(self);
  if (scope === "none") return [];
  return candidates
    .filter((c) => {
      if (c.locationId === null && c.address === null) return false;
      if (scope === "location") {
        return c.locationId === self.locationId || (c.locationId === null && self.address !== null && c.address === self.address);
      }
      return c.address !== null && c.address === self.address;
    })
    .map((c) => c.id);
}

/**
 * Membership is shown only when this request has an address, the customer has
 * at most one location, and EVERY non-cancelled request of the customer (this
 * one included) has an address normalising to the same one (spec §7.6).
 */
export function membershipEvaluable(selfAddress: string | null, locationCount: number, allAddresses: readonly (string | null)[]): boolean {
  return selfAddress !== null && locationCount <= 1 && allAddresses.every((a) => a === selfAddress);
}
```

`src/lib/tech/upload-limits.ts`:

```ts
/**
 * The technician upload cap (M3d spec §7.7), shared by the phone (resize, PDF
 * pick) and the photo route. Vercel Functions cap request bodies at 4.5 MB;
 * 4 MB leaves room for the multipart envelope. Client-safe: no imports.
 */
export const TECH_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
export const FILE_TOO_LARGE_COPY = "This file is too large. The limit is 4 MB.";
```

`src/lib/db/sql-arrays.ts`:

```ts
import { sql, type SQL } from "drizzle-orm";

/**
 * `ARRAY[$1::uuid, …]::uuid[]`; an empty list is `ARRAY[]::uuid[]`. Drizzle
 * expands a bare JS array in a `sql` template into a `($1, $2)` list, which
 * is not an array, so array parameters go through this.
 */
export function uuidArraySql(ids: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/forms src/lib/http src/lib/crypto.test.ts src/lib/admin/location-queries.test.ts`
Expected: PASS (form-gates 13, site-scope 7, idempotency +2, crypto +1; `location-queries.test.ts` unchanged).

- [ ] **Step 5: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/forms src/lib/http src/lib/crypto.ts src/lib/crypto.test.ts src/lib/admin/location-queries.ts src/lib/tech/upload-limits.ts src/lib/db/sql-arrays.ts && npx vitest run
git add src/lib/forms/form-gates.ts src/lib/forms/form-gates.test.ts src/lib/forms/site-scope.ts src/lib/forms/site-scope.test.ts src/lib/tech/upload-limits.ts src/lib/db/sql-arrays.ts src/lib/http/idempotency.ts src/lib/http/idempotency.test.ts src/lib/http/idempotency-codes.ts src/lib/crypto.ts src/lib/crypto.test.ts src/lib/admin/location-queries.ts
git commit -m "$(cat <<'EOF'
feat(m3d): form gates and visit counts, site scope, canonicalJson, labelled macHex, stored submit codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 4: Technician writers — draft (revision gate, `saveId` replay) and keyed submit

**Files:**
- Create: `src/lib/tech/form-writes.ts`, `src/lib/tech/form-writes.test.ts`, `src/lib/tech/form-errors.ts`, `src/lib/tech/form-errors.test.ts`

**Interfaces:**
- Consumes: `lockRequestSql`, `readRows`, `runBatch` (`src/lib/admin/invoice-field-writes.ts`); `encrypt`, `decrypt` (`src/lib/crypto.ts`); Task 2 `parseStoredFields`, `applyChanges`, `missingRequired`, `valuesTooLarge`, `Changes`, `FormValues`; Task 3 `requestGateSql`, `visitGateSql`, `readFormGatesSql`, `toFormGates`, `gateReason`, `FormGates`, `GateReason`; `RunResult` (`src/lib/http/idempotency.ts`); `errorResponse` (`@/lib/api-response`).
- Produces:
  - `form-writes.ts`: `type FormWriteReason = GateReason | "form_archived" | "form_changed" | "answers_removed" | "form_submitted" | "answers_unreadable" | "stale" | "invalid_values" | "values_too_large" | "form_incomplete"`; `interface FormWriteFail { ok: false; reason; fieldIds?; revision? }`; `interface FormActor { organizationId; requestId; techUserId }`; `interface DraftInput { formId; appointmentId; formVersion; baseRevision; saveId; changes }`; `type SubmitInput = Omit<DraftInput, "saveId">`; `saveFormDraft(actor, input): Promise<{ ok: true; submissionId; revision; savedAt; created } | FormWriteFail>`; `findDraftReplay(actor, input): Promise<DraftResult | null>` (the `saveId` replay alone, for the route to run before its gates, lead ruling 3); `submitForm(actor, input, { submitKey }): Promise<{ ok: true; submissionId; revision; submittedAt } | FormWriteFail>`; also `decryptValues(enc): FormValues | "unreadable"`, `encryptValues(values)`, `SubmissionRow`, `toSubmissionRow`, `selectSubmissionSql`, `insertSubmissionSql`, `updateSubmissionSql`, `submitAuditSql`, `zeroRowOutcome`.
  - `form-errors.ts`: `FORM_REASON: Record<FormWriteReason, { status; code; message }>`, `formReasonDetails(fail)`, `formReasonResult(fail): RunResult`, `formReasonResponse(fail): NextResponse`.

- [ ] **Step 1: Write the failing tests** — `src/lib/tech/form-writes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, batch, executed } = vi.hoisted(() => ({ readQueue: [] as unknown[][], batch: vi.fn(), executed: [] as unknown[] }));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => (executed.push(q), {
      __sql: q,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
        Promise.resolve({ rows: readQueue.shift() ?? [] }).then(ok, err),
    }),
    batch,
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `ENC:${s}`,
  decrypt: (s: string) => {
    if (s === "BAD") throw new Error("auth tag");
    return s.slice(4);
  },
}));

import { decryptValues, findDraftReplay, saveFormDraft, submitForm, zeroRowOutcome, type DraftInput, type SubmissionRow } from "./form-writes";
import type { FormGates } from "@/lib/forms/form-gates";

const ORG = "11111111-1111-4111-8111-111111111111";
const RID = "22222222-2222-4222-8222-222222222222";
const AID = "33333333-3333-4333-8333-333333333333";
const ME = "44444444-4444-4444-8444-444444444444";
const FORM = "55555555-5555-4555-8555-555555555555";
const SID = "66666666-6666-4666-8666-666666666666";
const SAVE = "abcdef12-3456-4789-8abc-def012345678";
const KEY = "fedcba98-7654-4321-8fed-cba987654321";
const actor = { organizationId: ORG, requestId: RID, techUserId: ME };
const TICK = { id: "f_0000000001", type: "checkbox", label: "Filter", required: true };
const NUM = { id: "f_0000000002", type: "number", label: "Suction", required: false, unit: "psi" };
const FIELDS = [TICK, NUM];
const T0 = "2026-11-07T14:41:00.000Z";

const draft = (over: Partial<DraftInput> = {}): DraftInput => ({
  formId: FORM, appointmentId: AID, formVersion: 1, baseRevision: 0, saveId: SAVE, changes: { [TICK.id]: true }, ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  id: SID, status: "draft", revision: 1, form_version: 1, erased: false, last_save_id: null, submit_key: null,
  updated_at: T0, submitted_at: null, fields: FIELDS, values_encrypted: null, ...over,
});

const dialect = new PgDialect();
const renderQ = (q: unknown) => dialect.sqlToQuery(((q as { __sql?: unknown }).__sql ?? q) as SQL);
const render = (q: unknown) => renderQ(q).sql.replace(/\s+/g, " ").trim();
const stmts = () => (batch.mock.calls[0]![0] as unknown[]).map(render);
const params = (i: number) => renderQ((batch.mock.calls[0]![0] as unknown[])[i]).params;
const rowsOf = (...r: unknown[][]) => r.map((rows) => ({ rows }));

const VISIT_GATE = "EXISTS (SELECT 1 FROM appointments p JOIN appointment_assignments a ON a.appointment_id = p.id";
const LOCK = "SELECT 1 FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE";
const orgCount = (i: number) => params(i).filter((p) => p === ORG).length;

beforeEach(() => { readQueue.length = 0; executed.length = 0; batch.mockReset(); });

describe("saveFormDraft (spec §5.2)", () => {
  it("replay is checked first: revision = base + 1 and the same saveId → 200, nothing else read", async () => {
    readQueue.push([row({ revision: 4, last_save_id: SAVE, values_encrypted: "BAD" })]);
    expect(await saveFormDraft(actor, draft({ baseRevision: 3, saveId: SAVE.toUpperCase() }))).toEqual({
      ok: true, submissionId: SID, revision: 4, savedAt: T0, created: false,
    });
    expect(batch).not.toHaveBeenCalled();
    expect(readQueue).toHaveLength(0);
  });

  it("first write: reads the live form, then one batch L_req → INSERT … SELECT → gated UPDATE → tail", async () => {
    readQueue.push([], [{ active: true, version: 1, fields: FIELDS }]);
    batch.mockResolvedValueOnce(rowsOf([], [{ id: SID }], [{ id: SID, revision: 1, updated_at: T0 }], [row()]));
    expect(await saveFormDraft(actor, draft())).toEqual({ ok: true, submissionId: SID, revision: 1, savedAt: T0, created: true });
    const s = stmts();
    expect(s).toHaveLength(4);
    expect(s[0]).toBe(LOCK);
    // The live form is read inside this org only.
    expect(render(executed[1])).toBe("SELECT active, version, fields FROM forms WHERE id = $1::uuid AND organization_id = $2::uuid");
    expect(s[1]).toMatch(/^INSERT INTO form_submissions \(organization_id, form_id, service_request_id, appointment_id, form_name, form_version, fields, started_by\) SELECT /);
    expect(s[1]).toContain("FROM forms f WHERE f.id = $");
    expect(s[1]).toContain("AND f.active AND f.version = $");
    expect(s[1]).toContain("EXISTS (SELECT 1 FROM service_requests rg");
    expect(s[1]).toContain("EXISTS (SELECT 1 FROM appointments p JOIN appointment_assignments a ON a.appointment_id = p.id");
    expect(s[1]).toContain("ON CONFLICT (appointment_id, form_id, service_request_id) DO NOTHING RETURNING id");
    expect(s[2]).toContain("SET values_encrypted = $1::text, revision = revision + 1, updated_by = $2::uuid, updated_at = now(), last_save_id = $3::uuid");
    expect(s[2]).toContain("AND status = 'draft' AND erased_at IS NULL AND revision = $");
    expect(s[2]).toContain("AND form_version = $");
    expect(s[2]).toContain("EXISTS (SELECT 1 FROM service_requests rg");
    // The UPDATE re-checks the visit (a technician removed after the route's gate read).
    expect(s[2]).toContain(VISIT_GATE);
    expect(params(2)[0]).toBe(`ENC:${JSON.stringify({ [TICK.id]: true })}`);
    // INSERT: forms, the row value, rg, gc, ga, p, a. UPDATE: the row, rg, gc, ga, p, a.
    expect(orgCount(1)).toBe(7);
    expect(orgCount(2)).toBe(6);
    // organization_id is bound on every statement.
    for (let i = 0; i < 4; i++) expect(params(i)).toContain(ORG);
  });

  it("an uppercase visit or form id from the client binds lowercase (Postgres returns lowercase uuids)", async () => {
    const UP = "ABCDEF12-3456-4789-8ABC-DEF012345678";
    expect(UP.toUpperCase()).toBe(UP);
    readQueue.push([], [{ active: true, version: 1, fields: FIELDS }]);
    batch.mockResolvedValueOnce(rowsOf([], [{ id: SID }], [{ id: SID, revision: 1, updated_at: T0 }], [row()]));
    await saveFormDraft(actor, draft({ appointmentId: UP, formId: FORM.toUpperCase() }));
    for (let i = 1; i < 4; i++) {
      expect(params(i)).toContain(UP.toLowerCase());
      expect(params(i)).not.toContain(UP);
    }
  });

  it("clearing every answer stores NULL", async () => {
    readQueue.push([row({ values_encrypted: `ENC:${JSON.stringify({ [TICK.id]: true })}` })]);
    batch.mockResolvedValueOnce(rowsOf([], [], [{ id: SID, revision: 2, updated_at: T0 }], [row({ revision: 2 })]));
    const r = await saveFormDraft(actor, draft({ baseRevision: 1, changes: { [TICK.id]: null } }));
    expect(r).toMatchObject({ ok: true, revision: 2, created: false });
    expect(params(2)[0]).toBeNull();
  });

  it("pre-read refusals: erased, submitted, other version, unreadable; no batch", async () => {
    for (const [r, reason] of [
      [row({ erased: true }), "answers_removed"],
      [row({ status: "submitted", submitted_at: T0 }), "form_submitted"],
      [row({ form_version: 2 }), "form_changed"],
      [row({ values_encrypted: "BAD" }), "answers_unreadable"],
    ] as const) {
      readQueue.push([r]);
      expect(await saveFormDraft(actor, draft({ baseRevision: 1 }))).toEqual({ ok: false, reason });
    }
    expect(batch).not.toHaveBeenCalled();
  });

  it("a base other than the pre-read revision is STALE before any decrypt or batch (spec §4.2)", async () => {
    readQueue.push([row({ revision: 3, values_encrypted: "BAD" })]);
    expect(await saveFormDraft(actor, draft({ baseRevision: 1 }))).toEqual({ ok: false, reason: "stale", revision: 3 });
    readQueue.push([]);
    expect(await saveFormDraft(actor, draft({ baseRevision: 2 }))).toEqual({ ok: false, reason: "stale", revision: 0 });
    expect(batch).not.toHaveBeenCalled();
  });

  it("findDraftReplay: a landed write's retry answers without the gates; anything else is null", async () => {
    readQueue.push([row({ revision: 2, last_save_id: SAVE })]);
    expect(await findDraftReplay(actor, draft({ baseRevision: 1 }))).toEqual({ ok: true, submissionId: SID, revision: 2, savedAt: T0, created: false });
    readQueue.push([row({ revision: 2, last_save_id: SAVE })]);
    expect(await findDraftReplay(actor, draft({ baseRevision: 1, saveId: KEY }))).toBeNull();
    readQueue.push([]);
    expect(await findDraftReplay(actor, draft())).toBeNull();
  });

  it("no row: missing form 404, archived, version changed", async () => {
    readQueue.push([], []);
    expect(await saveFormDraft(actor, draft())).toEqual({ ok: false, reason: "not_found" });
    readQueue.push([], [{ active: false, version: 1, fields: FIELDS }]);
    expect(await saveFormDraft(actor, draft())).toEqual({ ok: false, reason: "form_archived" });
    readQueue.push([], [{ active: true, version: 2, fields: FIELDS }]);
    expect(await saveFormDraft(actor, draft())).toEqual({ ok: false, reason: "form_changed" });
  });

  it("content: a bad value names its field; an injected over-128 KB document is values_too_large (lead ruling 5: no valid definition reaches the cap)", async () => {
    readQueue.push([], [{ active: true, version: 1, fields: FIELDS }]);
    expect(await saveFormDraft(actor, draft({ changes: { [NUM.id]: "12" } }))).toEqual({ ok: false, reason: "invalid_values", fieldIds: [NUM.id] });
    const LONG = { id: "f_0000000003", type: "long_text", label: "L", required: false };
    // An INJECTED snapshot with 22 long answers (a valid definition allows 10; stored fields skip that check):
    // 22 × 2,000 "€" = 132,000 UTF-8 bytes, each under its own limit, together over 128 KB.
    const big = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`f_00000001${String(i).padStart(2, "0")}`, "€".repeat(2000)]));
    const fields = [...FIELDS, LONG, ...Object.keys(big).map((id) => ({ ...LONG, id }))];
    readQueue.push([], [{ active: true, version: 1, fields }]);
    expect(await saveFormDraft(actor, draft({ changes: big }))).toEqual({ ok: false, reason: "values_too_large" });
  });

  it("zero rows: my own landed write → replay; a colleague's → STALE with their revision; a gate → its code", async () => {
    readQueue.push([row({ revision: 1 })], [row({ revision: 2, last_save_id: SAVE })]);
    batch.mockResolvedValueOnce(rowsOf([], [], [], [row({ revision: 2, last_save_id: SAVE })]));
    expect(await saveFormDraft(actor, draft({ baseRevision: 1 }))).toMatchObject({ ok: true, revision: 2, created: false });

    batch.mockReset();
    readQueue.length = 0;
    readQueue.push([row({ revision: 1 })], [{ status: "arrived", native: true, visit_found: true, visit_live: true, my_row: true, my_live_row: true, form_found: true, form_active: true, form_version: 1 }]);
    batch.mockResolvedValueOnce(rowsOf([], [], [], [row({ revision: 3 })]));
    expect(await saveFormDraft(actor, draft({ baseRevision: 1 }))).toEqual({ ok: false, reason: "stale", revision: 3 });

    batch.mockReset();
    readQueue.length = 0;
    readQueue.push([row({ revision: 1 })], [{ status: "cancelled", native: true, visit_found: true, visit_live: false }]);
    batch.mockResolvedValueOnce(rowsOf([], [], [], [row({ revision: 1 })]));
    expect(await saveFormDraft(actor, draft({ baseRevision: 1 }))).toEqual({ ok: false, reason: "job_closed" });
  });

  it("a deadlock is STALE, never a 500", async () => {
    readQueue.push([row()]);
    batch.mockRejectedValueOnce(Object.assign(new Error("deadlock"), { code: "40P01" }));
    expect(await saveFormDraft(actor, draft({ baseRevision: 1 }))).toEqual({ ok: false, reason: "stale", revision: 1 });
  });
});

describe("submitForm (spec §5.3)", () => {
  it("missing required → form_incomplete with the ids, no batch", async () => {
    readQueue.push([row()]);
    expect(await submitForm(actor, draft({ baseRevision: 1, changes: { [NUM.id]: 5 } }), { submitKey: KEY })).toEqual({
      ok: false, reason: "form_incomplete", fieldIds: [TICK.id],
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it("submits with the derived key and an in-batch audit gated on status, key and xmin", async () => {
    readQueue.push([row()]);
    batch.mockResolvedValueOnce(rowsOf([], [], [{ id: SID, revision: 2, updated_at: T0, submitted_at: T0 }], [{ id: "a" }], [row()]));
    expect(await submitForm(actor, draft({ baseRevision: 1 }), { submitKey: KEY.toUpperCase() })).toEqual({
      ok: true, submissionId: SID, revision: 2, submittedAt: T0,
    });
    const s = stmts();
    expect(s).toHaveLength(5);
    expect(s[0]).toBe(LOCK);
    expect(s[2]).toContain(VISIT_GATE);
    expect(s[2]).toContain("EXISTS (SELECT 1 FROM service_requests rg");
    expect(s[2]).toContain("status = 'submitted', submitted_by = $");
    expect(s[2]).toContain("submitted_at = now(), submit_key = $");
    expect(s[2]).not.toContain("last_save_id");
    expect(s[3]).toMatch(/^INSERT INTO audit_log \(organization_id, user_id, action, entity, entity_id, details\) SELECT s.organization_id, \$1::uuid, 'form_submitted', 'form_submissions', s.id, json_build_object\('formId', s.form_id, 'appointmentId', s.appointment_id, 'formVersion', s.form_version\)::text/);
    expect(s[3]).toContain("AND s.status = 'submitted' AND s.submit_key = $");
    expect(s[3]).toContain("AND s.xmin = pg_current_xact_id()::xid");
    expect(params(2)).toContain(KEY);
    expect(params(3)).toContain(KEY);
  });

  it("a takeover re-run of a committed submit answers 200 from the pre-read", async () => {
    readQueue.push([row({ status: "submitted", submit_key: KEY, submitted_at: T0, revision: 2 })]);
    expect(await submitForm(actor, draft({ baseRevision: 1 }), { submitKey: KEY })).toEqual({ ok: true, submissionId: SID, revision: 2, submittedAt: T0 });
    expect(batch).not.toHaveBeenCalled();
  });

  it("submitted by someone else → form_submitted", async () => {
    readQueue.push([row({ status: "submitted", submit_key: SAVE, submitted_at: T0 })]);
    expect(await submitForm(actor, draft({ baseRevision: 1 }), { submitKey: KEY })).toEqual({ ok: false, reason: "form_submitted" });
  });
});

describe("zeroRowOutcome", () => {
  const g: FormGates = {
    status: "arrived", native: true, customerErased: false, visitFound: true, visitLive: true, myRow: true,
    myLiveRow: true, myProgress: false, formFound: true, formActive: true, formVersion: 1,
  };
  const tail = (over: Partial<SubmissionRow> = {}): SubmissionRow => ({
    id: SID, status: "draft", revision: 2, formVersion: 1, erased: false, lastSaveId: null, submitKey: null,
    updatedAt: T0, submittedAt: null, fields: FIELDS, valuesEncrypted: null, ...over,
  });
  const inp = { formVersion: 1, baseRevision: 1 };
  it("no row: gates, then form found / active / version, then stale 0", () => {
    expect(zeroRowOutcome(null, { ...g, myLiveRow: false }, inp)).toEqual({ kind: "fail", fail: { ok: false, reason: "not_assigned" } });
    expect(zeroRowOutcome(null, { ...g, formFound: false }, inp)).toEqual({ kind: "fail", fail: { ok: false, reason: "not_found" } });
    expect(zeroRowOutcome(null, { ...g, formActive: false }, inp)).toEqual({ kind: "fail", fail: { ok: false, reason: "form_archived" } });
    expect(zeroRowOutcome(null, { ...g, formVersion: 2 }, inp)).toEqual({ kind: "fail", fail: { ok: false, reason: "form_changed" } });
    expect(zeroRowOutcome(null, g, inp)).toEqual({ kind: "fail", fail: { ok: false, reason: "stale", revision: 0 } });
  });
  it("row: erased, submitted, version, gates, stale", () => {
    expect(zeroRowOutcome(tail({ erased: true }), g, inp)).toMatchObject({ fail: { reason: "answers_removed" } });
    expect(zeroRowOutcome(tail({ status: "submitted" }), g, inp)).toMatchObject({ fail: { reason: "form_submitted" } });
    expect(zeroRowOutcome(tail({ status: "submitted", submitKey: KEY }), g, { ...inp, submitKey: KEY })).toEqual({ kind: "replay" });
    expect(zeroRowOutcome(tail({ formVersion: 2 }), g, inp)).toMatchObject({ fail: { reason: "form_changed" } });
    expect(zeroRowOutcome(tail(), { ...g, customerErased: true }, inp)).toMatchObject({ fail: { reason: "customer_removed" } });
    expect(zeroRowOutcome(tail({ revision: 5 }), g, inp)).toMatchObject({ fail: { reason: "stale", revision: 5 } });
  });
});

describe("decryptValues", () => {
  it("null → {}; a non-object or bad blob → unreadable", () => {
    expect(decryptValues(null)).toEqual({});
    expect(decryptValues("BAD")).toBe("unreadable");
    expect(decryptValues("ENC:[1]")).toBe("unreadable");
    expect(decryptValues('ENC:{"a":1}')).toEqual({ a: 1 });
  });
});
```

`src/lib/tech/form-errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isStorable } from "@/lib/http/idempotency";
import { FORM_REASON, formReasonResult } from "./form-errors";

describe("form reason results (spec §4.3, §8)", () => {
  it("stored codes are exactly the terminal submit answers", () => {
    const stored = Object.values(FORM_REASON).filter((s) => isStorable(s.status, { success: false, error: { message: "", code: s.code } })).map((s) => s.code);
    expect([...new Set(stored)].sort()).toEqual(["ANSWERS_REMOVED", "ANSWERS_UNREADABLE", "CUSTOMER_REMOVED", "FORM_INCOMPLETE", "FORM_SUBMITTED", "INVALID_INPUT"]);
  });

  it("details carry ids, a revision or a path only", () => {
    expect(formReasonResult({ ok: false, reason: "stale", revision: 4 }).envelope).toEqual({
      success: false, error: { message: "Someone else changed this form.", code: "STALE", details: { revision: 4 } },
    });
    expect(formReasonResult({ ok: false, reason: "values_too_large" }).envelope).toMatchObject({ error: { code: "INVALID_INPUT", details: { path: ["values"] } } });
    expect(formReasonResult({ ok: false, reason: "form_incomplete", fieldIds: ["f_0000000001"] })).toMatchObject({
      status: 400, envelope: { error: { code: "FORM_INCOMPLETE", details: { fieldIds: ["f_0000000001"] } } },
    });
    expect(formReasonResult({ ok: false, reason: "not_assigned" })).toMatchObject({ status: 403, envelope: { error: { message: "Only a technician on this visit can fill in its forms." } } });
    expect(formReasonResult({ ok: false, reason: "form_changed" }).envelope).toEqual({
      success: false, error: { message: "The office changed this form. Check your answers.", code: "FORM_CHANGED" },
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/tech/form-writes.test.ts src/lib/tech/form-errors.test.ts`
Expected: FAIL — cannot resolve `./form-writes` / `./form-errors`.

- [ ] **Step 3: Implement** — `src/lib/tech/form-writes.ts`:

```ts
/**
 * Technician form writes (M3d spec §5.2–§5.3). Draft = changes applied to the
 * decrypted document under a revision gate, replayed by `saveId` (checked
 * first, before any decrypt). Submit = the same batch, keyed by the route's
 * idempotency key, with an in-batch audit gated on the row THIS transaction
 * submitted. Each write is ONE db.batch led by L_req; every statement repeats
 * the request and visit gates; outcomes come from the batch's tail SELECT.
 */
import { sql, type SQL } from "drizzle-orm";
import { lockRequestSql, readRows, runBatch } from "@/lib/admin/invoice-field-writes";
import { decrypt, encrypt } from "@/lib/crypto";
import { parseStoredFields, type FormField } from "@/lib/forms/form-schema";
import { applyChanges, missingRequired, valuesTooLarge, type Changes, type FormValues } from "@/lib/forms/form-values";
import {
  gateReason, readFormGatesSql, requestGateSql, toFormGates, visitGateSql, type FormGates, type GateReason,
} from "@/lib/forms/form-gates";

export type FormWriteReason =
  | GateReason
  | "form_archived" | "form_changed" | "answers_removed" | "form_submitted" | "answers_unreadable"
  | "stale" | "invalid_values" | "values_too_large" | "form_incomplete";

export interface FormWriteFail {
  readonly ok: false;
  readonly reason: FormWriteReason;
  readonly fieldIds?: readonly string[];
  readonly revision?: number;
}

export interface FormActor { readonly organizationId: string; readonly requestId: string; readonly techUserId: string }

export interface DraftInput {
  readonly formId: string;
  readonly appointmentId: string;
  readonly formVersion: number;
  readonly baseRevision: number;
  readonly saveId: string;
  readonly changes: Changes;
}
export type SubmitInput = Omit<DraftInput, "saveId">;

export type DraftResult =
  | { readonly ok: true; readonly submissionId: string; readonly revision: number; readonly savedAt: string; readonly created: boolean }
  | FormWriteFail;
export type SubmitResult =
  | { readonly ok: true; readonly submissionId: string; readonly revision: number; readonly submittedAt: string }
  | FormWriteFail;

type Row = Record<string, unknown>;
const fail = (reason: FormWriteReason, extra: { fieldIds?: readonly string[]; revision?: number } = {}): FormWriteFail =>
  ({ ok: false, reason, ...extra });
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const lc = (s: string): string => s.toLowerCase();

/** The submission row by its natural key, every column the decisions read. */
export interface SubmissionRow {
  readonly id: string;
  readonly status: "draft" | "submitted";
  readonly revision: number;
  readonly formVersion: number;
  readonly erased: boolean;
  readonly lastSaveId: string | null;
  readonly submitKey: string | null;
  readonly updatedAt: string;
  readonly submittedAt: string | null;
  readonly fields: unknown;
  readonly valuesEncrypted: string | null;
}

export function toSubmissionRow(r: Row | undefined): SubmissionRow | null {
  if (!r) return null;
  return {
    id: String(r.id),
    status: r.status === "submitted" ? "submitted" : "draft",
    revision: Number(r.revision),
    formVersion: Number(r.form_version),
    erased: r.erased === true,
    lastSaveId: r.last_save_id == null ? null : String(r.last_save_id),
    submitKey: r.submit_key == null ? null : String(r.submit_key),
    updatedAt: iso(r.updated_at),
    submittedAt: r.submitted_at == null ? null : iso(r.submitted_at),
    fields: r.fields ?? null,
    valuesEncrypted: r.values_encrypted == null ? null : String(r.values_encrypted),
  };
}

const ROW_COLUMNS = sql.raw(
  "id, status, revision, form_version, erased_at IS NOT NULL AS erased, last_save_id, submit_key, updated_at, submitted_at, fields, values_encrypted",
);

function naturalKeySql(org: string, rid: string, aid: string, form: string): SQL {
  return sql`organization_id = ${org}::uuid AND appointment_id = ${aid}::uuid AND form_id = ${form}::uuid AND service_request_id = ${rid}::uuid`;
}

export function selectSubmissionSql(org: string, rid: string, aid: string, form: string): SQL {
  return sql`SELECT ${ROW_COLUMNS} FROM form_submissions WHERE ${naturalKeySql(org, rid, aid, form)}`;
}

/** Decrypt a stored document. null blob = no answers; a blob that won't decrypt or parse = "unreadable". */
export function decryptValues(enc: string | null): FormValues | "unreadable" {
  if (enc === null) return {};
  try {
    const parsed: unknown = JSON.parse(decrypt(enc));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable";
    return parsed as FormValues;
  } catch {
    return "unreadable";
  }
}

/** The empty document stores NULL (spec §3.2: NULL = no answers). */
export const encryptValues = (values: FormValues): string | null =>
  Object.keys(values).length === 0 ? null : encrypt(JSON.stringify(values));

/** First statement of the batch after L_req: create the row from the live form at `formVersion` (spec §5.2 step 1). */
export function insertSubmissionSql(a: FormActor, input: { formId: string; appointmentId: string; formVersion: number }): SQL {
  const { organizationId: org, requestId: rid, techUserId: me } = a;
  const aid = input.appointmentId;
  return sql`INSERT INTO form_submissions (organization_id, form_id, service_request_id, appointment_id, form_name, form_version, fields, started_by)
    SELECT ${org}::uuid, f.id, ${rid}::uuid, ${aid}::uuid, f.name, f.version, f.fields, ${me}::uuid FROM forms f
    WHERE f.id = ${input.formId}::uuid AND f.organization_id = ${org}::uuid AND f.active AND f.version = ${input.formVersion}::int
      AND ${requestGateSql(org, rid, aid, me)} AND ${visitGateSql(org, rid, aid, me)}
    ON CONFLICT (appointment_id, form_id, service_request_id) DO NOTHING RETURNING id`;
}

/** The gated UPDATE (spec §5.2 step 2); `set` adds the submit columns. */
export function updateSubmissionSql(a: FormActor, input: SubmitInput, enc: string | null, set: SQL): SQL {
  const { organizationId: org, requestId: rid, techUserId: me } = a;
  const aid = input.appointmentId;
  return sql`UPDATE form_submissions SET values_encrypted = ${enc}::text, revision = revision + 1, updated_by = ${me}::uuid, updated_at = now()${set}
    WHERE ${naturalKeySql(org, rid, aid, input.formId)} AND status = 'draft' AND erased_at IS NULL
      AND revision = ${input.baseRevision}::int AND form_version = ${input.formVersion}::int
      AND ${requestGateSql(org, rid, aid, me)} AND ${visitGateSql(org, rid, aid, me)}
    RETURNING id, revision, updated_at, submitted_at`;
}

/** Step 2b: audit only a row THIS transaction submitted with THIS key (spec §5.3). */
export function submitAuditSql(a: FormActor, input: SubmitInput, submitKey: string): SQL {
  const { organizationId: org, requestId: rid, techUserId: me } = a;
  return sql`INSERT INTO audit_log (organization_id, user_id, action, entity, entity_id, details)
    SELECT s.organization_id, ${me}::uuid, 'form_submitted', 'form_submissions', s.id,
      json_build_object('formId', s.form_id, 'appointmentId', s.appointment_id, 'formVersion', s.form_version)::text
    FROM form_submissions s
    WHERE s.organization_id = ${org}::uuid AND s.appointment_id = ${input.appointmentId}::uuid AND s.form_id = ${input.formId}::uuid
      AND s.service_request_id = ${rid}::uuid AND s.status = 'submitted' AND s.submit_key = ${submitKey}::uuid
      AND s.xmin = pg_current_xact_id()::xid`;
}

export type ZeroRow = { kind: "replay" } | { kind: "fail"; fail: FormWriteFail };

/**
 * The batch's UPDATE matched nothing (spec §5.2 "Zero rows from 2"): our own
 * landed write (save id, or this submit key) → replay; else the first refusal.
 */
export function zeroRowOutcome(
  tail: SubmissionRow | null,
  g: FormGates | null,
  input: { formVersion: number; baseRevision: number; saveId?: string; submitKey?: string },
): ZeroRow {
  if (tail && input.saveId !== undefined && tail.revision === input.baseRevision + 1 && tail.lastSaveId === lc(input.saveId)) {
    return { kind: "replay" };
  }
  if (tail && input.submitKey !== undefined && tail.status === "submitted" && tail.submitKey === lc(input.submitKey)) {
    return { kind: "replay" };
  }
  const gate = gateReason(g);
  if (!tail) {
    if (gate) return { kind: "fail", fail: fail(gate) };
    if (!g!.formFound) return { kind: "fail", fail: fail("not_found") };
    if (!g!.formActive) return { kind: "fail", fail: fail("form_archived") };
    if (g!.formVersion !== input.formVersion) return { kind: "fail", fail: fail("form_changed") };
    return { kind: "fail", fail: fail("stale", { revision: 0 }) };
  }
  if (tail.erased) return { kind: "fail", fail: fail("answers_removed") };
  if (tail.status === "submitted") return { kind: "fail", fail: fail("form_submitted") };
  if (tail.formVersion !== input.formVersion) return { kind: "fail", fail: fail("form_changed") };
  if (gate) return { kind: "fail", fail: fail(gate) };
  return { kind: "fail", fail: fail("stale", { revision: tail.revision }) };
}

type Prepared = { ok: true; values: FormValues; fields: readonly FormField[] } | FormWriteFail;

/** Pre-read decisions (spec §5.2 steps 2–3), then apply the changes. */
async function prepare(a: FormActor, input: SubmitInput, row: SubmissionRow | null): Promise<Prepared> {
  let fields: readonly FormField[] | null;
  let doc: FormValues;
  if (row) {
    if (row.erased) return fail("answers_removed");
    if (row.status === "submitted") return fail("form_submitted");
    if (row.formVersion !== input.formVersion) return fail("form_changed");
    // Spec §4.2 "the document it changed is the one it read": refuse a base other than the pre-read revision.
    if (row.revision !== input.baseRevision) return fail("stale", { revision: row.revision });
    const dec = decryptValues(row.valuesEncrypted);
    fields = parseStoredFields(row.fields);
    if (dec === "unreadable" || fields === null) return fail("answers_unreadable");
    doc = dec;
  } else {
    // No row yet: only revision 0 can be the base (a later base is a client that read a row since removed).
    if (input.baseRevision !== 0) return fail("stale", { revision: 0 });
    const [form] = await readRows(sql`SELECT active, version, fields FROM forms
      WHERE id = ${input.formId}::uuid AND organization_id = ${a.organizationId}::uuid`);
    if (!form) return fail("not_found");
    if (form.active !== true) return fail("form_archived");
    if (Number(form.version) !== input.formVersion) return fail("form_changed");
    fields = parseStoredFields(form.fields);
    if (fields === null) return fail("answers_unreadable");
    doc = {};
  }
  const applied = applyChanges(fields, doc, input.changes);
  if (!applied.ok) return fail("invalid_values", { fieldIds: applied.fieldIds });
  if (valuesTooLarge(applied.values)) return fail("values_too_large");
  return { ok: true, values: applied.values, fields };
}

async function readGates(a: FormActor, input: SubmitInput): Promise<FormGates | null> {
  const [g] = await readRows(readFormGatesSql(a.organizationId, a.requestId, input.appointmentId, a.techUserId, input.formId));
  return toFormGates(g);
}

const normDraft = (raw: DraftInput): DraftInput =>
  ({ ...raw, appointmentId: lc(raw.appointmentId), formId: lc(raw.formId), saveId: lc(raw.saveId) });

function replayOf(row: SubmissionRow | null, input: DraftInput): DraftResult | null {
  return row && row.revision === input.baseRevision + 1 && row.lastSaveId === input.saveId
    ? { ok: true, submissionId: row.id, revision: row.revision, savedAt: row.updatedAt, created: false }
    : null;
}

/**
 * The replay probe the draft route runs BEFORE its gates (spec §4.2: "the replay
 * check runs first"): a retry of a write that landed answers 200 even after the
 * visit ended or the job closed. The saveId is a client-minted uuid, so a match
 * proves the caller sent the write.
 */
export async function findDraftReplay(a: FormActor, raw: DraftInput): Promise<DraftResult | null> {
  const input = normDraft(raw);
  const [pre] = await readRows(selectSubmissionSql(a.organizationId, a.requestId, input.appointmentId, input.formId));
  return replayOf(toSubmissionRow(pre), input);
}

export async function saveFormDraft(a: FormActor, raw: DraftInput): Promise<DraftResult> {
  const input = normDraft(raw);
  const { organizationId: org, requestId: rid } = a;
  const [pre] = await readRows(selectSubmissionSql(org, rid, input.appointmentId, input.formId));
  const row = toSubmissionRow(pre);
  // 1. Replay first: nothing else is read, decrypted, applied or measured.
  const replay = replayOf(row, input);
  if (replay) return replay;
  const prepared = await prepare(a, input, row);
  if (!prepared.ok) return prepared;
  const enc = encryptValues(prepared.values);

  const out = await runBatch([
    lockRequestSql(org, rid),
    insertSubmissionSql(a, input),
    updateSubmissionSql(a, input, enc, sql`, last_save_id = ${input.saveId}::uuid`),
    selectSubmissionSql(org, rid, input.appointmentId, input.formId),
  ]);
  if (!Array.isArray(out)) return fail("stale", { revision: row?.revision ?? 0 });
  const [, inserted, updated, tailRows] = out;
  const up = updated![0];
  if (up) {
    return { ok: true, submissionId: String(up.id), revision: Number(up.revision), savedAt: iso(up.updated_at), created: inserted!.length > 0 };
  }
  const tail = toSubmissionRow(tailRows![0]);
  const z = zeroRowOutcome(tail, await readGates(a, input), input);
  if (z.kind === "replay") return { ok: true, submissionId: tail!.id, revision: tail!.revision, savedAt: tail!.updatedAt, created: false };
  return z.fail;
}

export async function submitForm(a: FormActor, raw: SubmitInput, ids: { submitKey: string }): Promise<SubmitResult> {
  const input = { ...raw, appointmentId: lc(raw.appointmentId), formId: lc(raw.formId) };
  const submitKey = lc(ids.submitKey);
  const { organizationId: org, requestId: rid, techUserId: me } = a;
  const [pre] = await readRows(selectSubmissionSql(org, rid, input.appointmentId, input.formId));
  const row = toSubmissionRow(pre);
  // A takeover re-run of a submit that already committed (its audit committed with it).
  if (row && row.status === "submitted" && row.submitKey === submitKey) {
    return { ok: true, submissionId: row.id, revision: row.revision, submittedAt: row.submittedAt! };
  }
  const prepared = await prepare(a, input, row);
  if (!prepared.ok) return prepared;
  const missing = missingRequired(prepared.fields, prepared.values);
  if (missing.length > 0) return fail("form_incomplete", { fieldIds: missing });
  const enc = encryptValues(prepared.values);

  const out = await runBatch([
    lockRequestSql(org, rid),
    insertSubmissionSql(a, input),
    updateSubmissionSql(a, input, enc,
      sql`, status = 'submitted', submitted_by = ${me}::uuid, submitted_at = now(), submit_key = ${submitKey}::uuid`),
    submitAuditSql(a, input, submitKey),
    selectSubmissionSql(org, rid, input.appointmentId, input.formId),
  ]);
  if (!Array.isArray(out)) return fail("stale", { revision: row?.revision ?? 0 });
  const [, , updated, , tailRows] = out;
  const up = updated![0];
  if (up) return { ok: true, submissionId: String(up.id), revision: Number(up.revision), submittedAt: iso(up.submitted_at) };
  const tail = toSubmissionRow(tailRows![0]);
  const z = zeroRowOutcome(tail, await readGates(a, input), { ...input, submitKey });
  if (z.kind === "replay") return { ok: true, submissionId: tail!.id, revision: tail!.revision, submittedAt: tail!.submittedAt! };
  return z.fail;
}
```

`src/lib/tech/form-errors.ts`:

```ts
/** Reason → HTTP status / code / copy / details for the technician form writes (M3d spec §4.3, §8). */
import type { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-response";
import type { RunResult } from "@/lib/http/idempotency";
import type { FormWriteFail, FormWriteReason } from "@/lib/tech/form-writes";

type Shape = { status: number; code: string; message: string };

export const FORM_REASON: Record<FormWriteReason, Shape> = {
  not_found: { status: 404, code: "NOT_FOUND", message: "This form is no longer on this job." },
  job_closed: { status: 409, code: "JOB_CLOSED", message: "This job is closed." },
  visit_ended: { status: 409, code: "VISIT_ENDED", message: "This visit has ended." },
  not_assigned: { status: 403, code: "NOT_ASSIGNED", message: "Only a technician on this visit can fill in its forms." },
  not_on_site: { status: 409, code: "NOT_ON_SITE", message: "Arrive at the job first." },
  customer_removed: { status: 409, code: "CUSTOMER_REMOVED", message: "This job's customer was removed." },
  form_archived: { status: 409, code: "FORM_ARCHIVED", message: "This form was archived by the office." },
  form_changed: { status: 409, code: "FORM_CHANGED", message: "The office changed this form. Check your answers." },
  answers_removed: { status: 409, code: "ANSWERS_REMOVED", message: "These answers were removed." },
  form_submitted: { status: 409, code: "FORM_SUBMITTED", message: "This form was already submitted." },
  answers_unreadable: { status: 409, code: "ANSWERS_UNREADABLE", message: "These answers can't be shown." },
  stale: { status: 409, code: "STALE", message: "Someone else changed this form." },
  invalid_values: { status: 400, code: "INVALID_INPUT", message: "Couldn't save your answers." },
  values_too_large: { status: 400, code: "INVALID_INPUT", message: "This form is too long to save. Shorten the longest answers." },
  form_incomplete: { status: 400, code: "FORM_INCOMPLETE", message: "Answer the required questions." },
};

/** Details are ids, a revision or a path only (spec §3.3), never zod text or answers. */
export function formReasonDetails(f: FormWriteFail): Record<string, unknown> | undefined {
  if (f.reason === "values_too_large") return { path: ["values"] };
  if (f.fieldIds) return { fieldIds: [...f.fieldIds] };
  if (f.reason === "stale") return { revision: f.revision ?? 0 };
  return undefined;
}

export function formReasonResult(f: FormWriteFail): RunResult {
  const { status, code, message } = FORM_REASON[f.reason];
  const details = formReasonDetails(f);
  return { status, envelope: { success: false, error: details ? { message, code, details } : { message, code } } };
}

export function formReasonResponse(f: FormWriteFail): NextResponse {
  const { status, code, message } = FORM_REASON[f.reason];
  return errorResponse(message, code, status, formReasonDetails(f));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/tech/form-writes.test.ts src/lib/tech/form-errors.test.ts`
Expected: PASS (18 + 2).

- [ ] **Step 5: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/form-writes.ts src/lib/tech/form-writes.test.ts src/lib/tech/form-errors.ts src/lib/tech/form-errors.test.ts && npx vitest run
git add src/lib/tech/form-writes.ts src/lib/tech/form-writes.test.ts src/lib/tech/form-errors.ts src/lib/tech/form-errors.test.ts
git commit -m "$(cat <<'EOF'
feat(m3d): form draft writer (revision gate, saveId replay first) and keyed submit with xmin-gated audit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---
### Task 5: Office writers and readers — create, PATCH with CAS, reopen, the request's answers

**Files:**
- Create: `src/lib/admin/form-queries.ts`, `src/lib/admin/form-queries.test.ts`

**Interfaces:**
- Consumes: `readRows` (`src/lib/admin/invoice-field-writes.ts`); `isUniqueViolation` (`src/lib/db/unique-violation.ts`, unwraps the drizzle `.cause`); `uuidArraySql` (Task 3); `officeId` (Task 3); Task 2 `FORM_LIMITS`, `parseStoredFields`, `questionCount`, `FormDefinition`, `FormField`, `FormValues`; Task 3 `formAppliesSql`, `visitCountsSql`; Task 4 `decryptValues`.
- Produces: `NAME_INDEX = "forms_org_name_active_unique"`; `interface FormRecord`; `interface FormListRow`; `listForms(org)`; `getForm(org, id): { form; submissionCount } | null`; `hasUnknownJobType(org, ids)`; `createForm(org, me, clientToken, def): { ok: true; id; created } | { ok: false; reason: "limit_reached" | "name_taken" | "unknown_job_type" }`; `interface FormPatch { version; definition?; active? }`; `updateForm(org, id, patch): { ok: true; version } | { ok: false; reason: "not_found" | "stale" | "name_taken" | "unknown_job_type" }`; `reopenSubmission(org, rid, sid, revision): { ok: true; revision; changed; formId; appointmentId } | { ok: false; reason: "not_found" | "answers_removed" | "stale" }`; `interface OfficeSubmission` (`visitState: "live" | "ended"`); `interface RequestForms { submissions; missingRequired }`; `requestSubmissionsSql`, `missingRequiredFormsSql`, `toOfficeSubmission`, `getRequestForms(org, rid): RequestForms | null`.

- [ ] **Step 1: Write the failing test** — `src/lib/admin/form-queries.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, executed, failNext } = vi.hoisted(() => ({
  readQueue: [] as unknown[][],
  executed: [] as unknown[],
  failNext: { error: null as unknown },
}));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => {
      executed.push(q);
      if (failNext.error) {
        const e = failNext.error;
        failNext.error = null;
        return Promise.reject(e);
      }
      return Promise.resolve({ rows: readQueue.shift() ?? [] });
    },
    batch: vi.fn(),
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `ENC:${s}`,
  decrypt: (s: string) => {
    if (s === "BAD") throw new Error("auth tag");
    return s.slice(4);
  },
}));

import { createForm, missingRequiredFormsSql, reopenSubmission, requestSubmissionsSql, toOfficeSubmission, updateForm } from "./form-queries";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import { officeId } from "@/lib/http/idempotency";
import type { FormDefinition } from "@/lib/forms/form-schema";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";
const JT = "44444444-4444-4444-8444-444444444444";
const FID = "55555555-5555-4555-8555-555555555555";
const RID = "66666666-6666-4666-8666-666666666666";
const SID = "77777777-7777-4777-8777-777777777777";
const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.replace(/\s+/g, " ").trim();
const params = (q: unknown) => dialect.sqlToQuery(q as SQL).params;
const def = (over: Partial<FormDefinition> = {}): FormDefinition => ({
  name: "Maintenance checklist", description: null, jobTypeIds: [], required: true,
  fields: [{ id: "f_0000000001", type: "checkbox", label: "Filter", required: true }], ...over,
});
const unique = Object.assign(new Error("dup"), { cause: { code: "23505", constraint: "forms_org_name_active_unique" } });

beforeEach(() => { readQueue.length = 0; executed.length = 0; failNext.error = null; });

describe("createForm (spec §4.1)", () => {
  it("id is officeId('form', org, token); INSERT … WHERE count < 100 ON CONFLICT (id) DO NOTHING", async () => {
    readQueue.push([{ id: "x" }]);
    const id = officeId("form", ORG, TOKEN);
    expect(await createForm(ORG, ME, TOKEN, def())).toEqual({ ok: true, id, created: true });
    const s = render(executed[0]);
    expect(s).toMatch(/^INSERT INTO forms \(id, organization_id, name, description, fields, job_type_ids, required, created_by\) SELECT \$1::uuid, \$2::uuid/);
    expect(s).toContain("::jsonb, ARRAY[]::uuid[], $");
    expect(s).toContain("WHERE (SELECT count(*) FROM forms WHERE organization_id = $");
    expect(s).toContain(") < $");
    expect(s).toContain("ON CONFLICT (id) DO NOTHING RETURNING id");
    expect(params(executed[0])).toContain(100);
  });

  it("a replay (same token) returns the existing id with created:false; a full org → limit_reached", async () => {
    readQueue.push([], [{ id: "x" }]);
    expect(await createForm(ORG, ME, TOKEN, def())).toMatchObject({ ok: true, created: false });
    readQueue.push([], []);
    expect(await createForm(ORG, ME, TOKEN, def())).toEqual({ ok: false, reason: "limit_reached" });
  });

  it("name collision → name_taken; unknown job type → unknown_job_type before any insert", async () => {
    failNext.error = unique;
    expect(await createForm(ORG, ME, TOKEN, def())).toEqual({ ok: false, reason: "name_taken" });
    executed.length = 0;
    readQueue.push([{ n: 0 }]);
    expect(await createForm(ORG, ME, TOKEN, def({ jobTypeIds: [JT] }))).toEqual({ ok: false, reason: "unknown_job_type" });
    expect(executed).toHaveLength(1);
    expect(render(executed[0])).toContain("FROM job_types WHERE organization_id = $1::uuid AND id = ANY(ARRAY[$2::uuid]::uuid[])");
  });
});

describe("updateForm", () => {
  it("CAS on version; zero rows → stale when the form exists, else not_found", async () => {
    readQueue.push([{ version: 3 }]);
    expect(await updateForm(ORG, FID, { version: 2, definition: def() })).toEqual({ ok: true, version: 3 });
    expect(render(executed[0])).toContain("SET version = version + 1, updated_at = now(), name = $");
    expect(render(executed[0])).toContain("WHERE id = $");
    expect(render(executed[0])).toContain("AND version = $");
    readQueue.push([], [{ "?column?": 1 }]);
    expect(await updateForm(ORG, FID, { version: 2, active: false })).toEqual({ ok: false, reason: "stale" });
    readQueue.push([], []);
    expect(await updateForm(ORG, FID, { version: 2, active: false })).toEqual({ ok: false, reason: "not_found" });
  });

  it("restoring an archived form whose name is now taken → name_taken", async () => {
    failNext.error = unique;
    expect(await updateForm(ORG, FID, { version: 4, active: true })).toEqual({ ok: false, reason: "name_taken" });
  });
});

describe("reopenSubmission (spec §5.5)", () => {
  it("changed; already a draft → changed:false; erased; stale; missing", async () => {
    readQueue.push([{ revision: 5, form_id: FID, appointment_id: "a" }]);
    expect(await reopenSubmission(ORG, RID, SID, 4)).toEqual({ ok: true, revision: 5, changed: true, formId: FID, appointmentId: "a" });
    expect(render(executed[0])).toContain("AND status = 'submitted' AND erased_at IS NULL AND revision = $");
    expect(render(executed[0])).toContain("WHERE id = $1::uuid AND organization_id = $2::uuid AND service_request_id = $3::uuid");
    readQueue.push([], [{ status: "draft", revision: 5, erased: false, form_id: FID, appointment_id: "a" }]);
    expect(await reopenSubmission(ORG, RID, SID, 4)).toMatchObject({ ok: true, changed: false, revision: 5 });
    readQueue.push([], [{ status: "submitted", revision: 6, erased: true }]);
    expect(await reopenSubmission(ORG, RID, SID, 4)).toEqual({ ok: false, reason: "answers_removed" });
    readQueue.push([], [{ status: "submitted", revision: 6, erased: false }]);
    expect(await reopenSubmission(ORG, RID, SID, 4)).toEqual({ ok: false, reason: "stale" });
    readQueue.push([], []);
    expect(await reopenSubmission(ORG, RID, SID, 4)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("office reads (spec §6)", () => {
  it("submissions omit unerased answerless drafts; every table org-bound", () => {
    const s = render(requestSubmissionsSql(ORG, RID));
    expect(s).toContain("AND NOT (s.status = 'draft' AND s.erased_at IS NULL AND s.values_encrypted IS NULL)");
    expect(params(requestSubmissionsSql(ORG, RID)).filter((p) => p === ORG)).toHaveLength(5);
  });

  it("missingRequired: not on cancelled, created before completion, counted only on visits that count", () => {
    const s = render(missingRequiredFormsSql(ORG, RID));
    expect(s).toContain("r.status <> 'cancelled'::request_status");
    expect(s).toContain("(r.status <> 'completed'::request_status OR r.completed_at IS NULL OR f.created_at < r.completed_at)");
    expect(s).toContain("(cardinality(f.job_type_ids) = 0 OR r.job_type_id = ANY(f.job_type_ids))");
    expect(s).toContain("(p.cancelled_at IS NULL OR EXISTS (SELECT 1 FROM appointment_assignments vca");
    // r, f, p, s, vca, vcs: every table bound to the org.
    expect(params(missingRequiredFormsSql(ORG, RID)).filter((p) => p === ORG)).toHaveLength(6);
    expect(s).toContain("WHERE f.organization_id = $");
  });

  it("an undecryptable blob reads unreadable with null values, never throws; an ended visit reads 'ended'", () => {
    const o = toOfficeSubmission({
      id: SID, form_id: FID, form_name: "M", form_version: 1, appointment_id: "a", appointment_number: 1, visit_live: false,
      status: "submitted", revision: 2, erased: false, fields: [], values_encrypted: "BAD", updated_at: "2026-11-07T00:00:00Z",
      updated_by_name: null, submitted_at: "2026-11-07T00:00:00Z", submitted_by_name: "Alex Rivera", visit_has_technician: false,
    });
    expect(o).toMatchObject({ unreadable: true, values: null, visitState: "ended", submittedByName: "Alex Rivera" });
  });

  it("uuidArraySql builds an ARRAY of uuid params", () => {
    expect(render(uuidArraySql([JT, FID]))).toBe("ARRAY[$1::uuid, $2::uuid]::uuid[]");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/admin/form-queries.test.ts`
Expected: FAIL — cannot resolve `./form-queries`.

- [ ] **Step 3: Implement** — `src/lib/admin/form-queries.ts`:

```ts
/**
 * Office form writers and readers (M3d spec §4.1, §5.5, §5.6, §6). Raw SQL,
 * organization_id bound on every table reference. Audits are written by the
 * routes (ids and enums only) and only when something changed.
 */
import { sql, type SQL } from "drizzle-orm";
import { readRows } from "@/lib/admin/invoice-field-writes";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import { officeId } from "@/lib/http/idempotency";
import { FORM_LIMITS, parseStoredFields, questionCount, type FormDefinition, type FormField } from "@/lib/forms/form-schema";
import type { FormValues } from "@/lib/forms/form-values";
import { formAppliesSql, visitCountsSql } from "@/lib/forms/form-gates";
import { decryptValues } from "@/lib/tech/form-writes";

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

export const NAME_INDEX = "forms_org_name_active_unique";

export interface FormRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly fields: readonly FormField[];
  readonly jobTypeIds: readonly string[];
  readonly required: boolean;
  readonly active: boolean;
  readonly version: number;
  readonly updatedAt: string;
}

export interface FormListRow {
  readonly id: string;
  readonly name: string;
  readonly questionCount: number;
  readonly jobTypeIds: readonly string[];
  readonly required: boolean;
  readonly active: boolean;
  readonly version: number;
  readonly updatedAt: string;
  readonly submissionCount: number;
}

const SUBMISSION_COUNT = sql.raw("(SELECT count(*)::int FROM form_submissions s WHERE s.form_id = f.id AND s.organization_id = f.organization_id)");

export async function listForms(org: string): Promise<FormListRow[]> {
  const rows = await readRows(sql`SELECT f.id, f.name, f.fields, f.job_type_ids, f.required, f.active, f.version, f.updated_at, ${SUBMISSION_COUNT} AS submission_count
    FROM forms f WHERE f.organization_id = ${org}::uuid ORDER BY f.active DESC, lower(f.name), f.id`);
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    questionCount: questionCount(parseStoredFields(r.fields) ?? []),
    jobTypeIds: (r.job_type_ids as string[] | null) ?? [],
    required: r.required === true,
    active: r.active === true,
    version: Number(r.version),
    updatedAt: iso(r.updated_at),
    submissionCount: Number(r.submission_count),
  }));
}

function toRecord(r: Row): FormRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    description: r.description == null ? null : String(r.description),
    fields: parseStoredFields(r.fields) ?? [],
    jobTypeIds: (r.job_type_ids as string[] | null) ?? [],
    required: r.required === true,
    active: r.active === true,
    version: Number(r.version),
    updatedAt: iso(r.updated_at),
  };
}

export async function getForm(org: string, id: string): Promise<{ form: FormRecord; submissionCount: number } | null> {
  const [r] = await readRows(sql`SELECT f.*, ${SUBMISSION_COUNT} AS submission_count FROM forms f
    WHERE f.id = ${id}::uuid AND f.organization_id = ${org}::uuid`);
  return r ? { form: toRecord(r), submissionCount: Number(r.submission_count) } : null;
}

/** Every id must be one of the org's job types, archived ones included. */
export async function hasUnknownJobType(org: string, ids: readonly string[]): Promise<boolean> {
  const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
  if (unique.length === 0) return false;
  const [r] = await readRows(sql`SELECT count(*)::int AS n FROM job_types
    WHERE organization_id = ${org}::uuid AND id = ANY(${uuidArraySql(unique)})`);
  return Number(r?.n ?? 0) !== unique.length;
}

export type CreateFormResult =
  | { readonly ok: true; readonly id: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: "limit_reached" | "name_taken" | "unknown_job_type" };

/** First valid Save (spec §4.1): id = officeId("form", org, clientToken); a replay returns the same id. */
export async function createForm(org: string, me: string, clientToken: string, def: FormDefinition): Promise<CreateFormResult> {
  const id = officeId("form", org, clientToken);
  if (await hasUnknownJobType(org, def.jobTypeIds)) return { ok: false, reason: "unknown_job_type" };
  let inserted: Row[];
  try {
    inserted = await readRows(sql`INSERT INTO forms (id, organization_id, name, description, fields, job_type_ids, required, created_by)
      SELECT ${id}::uuid, ${org}::uuid, ${def.name}, ${def.description}::text, ${JSON.stringify(def.fields)}::jsonb,
        ${uuidArraySql(def.jobTypeIds.map((j) => j.toLowerCase()))}, ${def.required}, ${me}::uuid
      WHERE (SELECT count(*) FROM forms WHERE organization_id = ${org}::uuid) < ${FORM_LIMITS.maxForms}
      ON CONFLICT (id) DO NOTHING RETURNING id`);
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) return { ok: false, reason: "name_taken" };
    throw error;
  }
  if (inserted.length > 0) return { ok: true, id, created: true };
  const [existing] = await readRows(sql`SELECT id FROM forms WHERE id = ${id}::uuid AND organization_id = ${org}::uuid`);
  return existing ? { ok: true, id, created: false } : { ok: false, reason: "limit_reached" };
}

export interface FormPatch {
  readonly version: number;
  readonly definition?: FormDefinition;
  readonly active?: boolean;
}

export type UpdateFormResult =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly reason: "not_found" | "stale" | "name_taken" | "unknown_job_type" };

/** PATCH with a version CAS (spec §4.1): fields replaced whole; archive / restore through `active`. */
export async function updateForm(org: string, id: string, patch: FormPatch): Promise<UpdateFormResult> {
  const d = patch.definition;
  if (d && (await hasUnknownJobType(org, d.jobTypeIds))) return { ok: false, reason: "unknown_job_type" };
  const sets: SQL[] = [sql`version = version + 1`, sql`updated_at = now()`];
  if (d) {
    sets.push(
      sql`name = ${d.name}`,
      sql`description = ${d.description}::text`,
      sql`fields = ${JSON.stringify(d.fields)}::jsonb`,
      sql`job_type_ids = ${uuidArraySql(d.jobTypeIds.map((j) => j.toLowerCase()))}`,
      sql`required = ${d.required}`,
    );
  }
  if (patch.active !== undefined) sets.push(sql`active = ${patch.active}`);
  let rows: Row[];
  try {
    rows = await readRows(sql`UPDATE forms SET ${sql.join(sets, sql`, `)}
      WHERE id = ${id}::uuid AND organization_id = ${org}::uuid AND version = ${patch.version}::int RETURNING version`);
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) return { ok: false, reason: "name_taken" };
    throw error;
  }
  if (rows[0]) return { ok: true, version: Number(rows[0].version) };
  const [exists] = await readRows(sql`SELECT 1 FROM forms WHERE id = ${id}::uuid AND organization_id = ${org}::uuid`);
  return { ok: false, reason: exists ? "stale" : "not_found" };
}

export type ReopenResult =
  | { readonly ok: true; readonly revision: number; readonly changed: boolean; readonly formId: string; readonly appointmentId: string }
  | { readonly ok: false; readonly reason: "not_found" | "answers_removed" | "stale" };

/** Office reopen (spec §5.5): submitted → draft under a revision CAS. */
export async function reopenSubmission(org: string, rid: string, sid: string, revision: number): Promise<ReopenResult> {
  const [r] = await readRows(sql`UPDATE form_submissions SET status = 'draft', submitted_at = NULL, submitted_by = NULL, submit_key = NULL,
      revision = revision + 1, updated_at = now()
    WHERE id = ${sid}::uuid AND organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
      AND status = 'submitted' AND erased_at IS NULL AND revision = ${revision}::int
    RETURNING revision, form_id, appointment_id`);
  if (r) return { ok: true, revision: Number(r.revision), changed: true, formId: String(r.form_id), appointmentId: String(r.appointment_id) };
  const [cur] = await readRows(sql`SELECT status, revision, erased_at IS NOT NULL AS erased, form_id, appointment_id FROM form_submissions
    WHERE id = ${sid}::uuid AND organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid`);
  if (!cur) return { ok: false, reason: "not_found" };
  if (cur.erased === true) return { ok: false, reason: "answers_removed" };
  if (cur.status === "draft") {
    return { ok: true, revision: Number(cur.revision), changed: false, formId: String(cur.form_id), appointmentId: String(cur.appointment_id) };
  }
  return { ok: false, reason: "stale" };
}

export interface OfficeSubmission {
  readonly id: string;
  readonly formId: string;
  readonly formName: string;
  readonly formVersion: number;
  readonly appointmentId: string;
  readonly appointmentNumber: number;
  readonly visitState: "live" | "ended";
  readonly status: "draft" | "submitted";
  readonly revision: number;
  readonly erased: boolean;
  readonly unreadable: boolean;
  readonly fields: readonly FormField[];
  readonly values: FormValues | null;
  readonly updatedAt: string;
  readonly updatedByName: string | null;
  readonly submittedAt: string | null;
  readonly submittedByName: string | null;
  readonly visitHasTechnician: boolean;
}

export interface RequestForms {
  readonly submissions: readonly OfficeSubmission[];
  readonly missingRequired: ReadonlyArray<{ readonly formId: string; readonly name: string }>;
}

export function requestSubmissionsSql(org: string, rid: string): SQL {
  return sql`SELECT s.id, s.form_id, s.form_name, s.form_version, s.appointment_id, p.appointment_number,
      (p.cancelled_at IS NULL) AS visit_live, s.status, s.revision, s.erased_at IS NOT NULL AS erased, s.fields, s.values_encrypted,
      s.updated_at, uu.name AS updated_by_name, s.submitted_at, su.name AS submitted_by_name,
      EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.appointment_id = p.id AND a.organization_id = ${org}::uuid
        AND a.status <> 'cancelled'::request_status) AS visit_has_technician
    FROM form_submissions s
    JOIN appointments p ON p.id = s.appointment_id AND p.organization_id = ${org}::uuid
    LEFT JOIN users uu ON uu.id = s.updated_by AND uu.organization_id = ${org}::uuid
    LEFT JOIN users su ON su.id = s.submitted_by AND su.organization_id = ${org}::uuid
    WHERE s.organization_id = ${org}::uuid AND s.service_request_id = ${rid}::uuid
      AND NOT (s.status = 'draft' AND s.erased_at IS NULL AND s.values_encrypted IS NULL)
    ORDER BY p.appointment_number, lower(s.form_name), s.id`;
}

/**
 * Required active forms that apply to the request with no submitted copy on a
 * visit that counts; none on a cancelled request; on a completed one only
 * forms created before it was completed (spec §6).
 */
export function missingRequiredFormsSql(org: string, rid: string): SQL {
  return sql`SELECT f.id, f.name FROM forms f
    JOIN service_requests r ON r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
    WHERE f.organization_id = ${org}::uuid AND f.required AND f.active AND ${formAppliesSql("f", "r")}
      AND r.status <> 'cancelled'::request_status
      AND (r.status <> 'completed'::request_status OR r.completed_at IS NULL OR f.created_at < r.completed_at)
      AND NOT EXISTS (SELECT 1 FROM form_submissions s JOIN appointments p ON p.id = s.appointment_id AND p.organization_id = ${org}::uuid
        WHERE s.organization_id = ${org}::uuid AND s.service_request_id = r.id AND s.form_id = f.id AND s.status = 'submitted'
          AND ${visitCountsSql(org, "p")})
    ORDER BY lower(f.name), f.id`;
}

export function toOfficeSubmission(r: Row): OfficeSubmission {
  const erased = r.erased === true;
  const dec = erased ? null : decryptValues(r.values_encrypted == null ? null : String(r.values_encrypted));
  return {
    id: String(r.id),
    formId: String(r.form_id),
    formName: String(r.form_name),
    formVersion: Number(r.form_version),
    appointmentId: String(r.appointment_id),
    appointmentNumber: Number(r.appointment_number),
    visitState: r.visit_live === true ? "live" : "ended",
    status: r.status === "submitted" ? "submitted" : "draft",
    revision: Number(r.revision),
    erased,
    unreadable: dec === "unreadable",
    fields: parseStoredFields(r.fields) ?? [],
    values: dec === null || dec === "unreadable" ? null : dec,
    updatedAt: iso(r.updated_at),
    updatedByName: r.updated_by_name == null ? null : String(r.updated_by_name),
    submittedAt: isoOrNull(r.submitted_at),
    submittedByName: r.submitted_by_name == null ? null : String(r.submitted_by_name),
    visitHasTechnician: r.visit_has_technician === true,
  };
}

/** Null when the request is not in the org. */
export async function getRequestForms(org: string, rid: string): Promise<RequestForms | null> {
  const [req] = await readRows(sql`SELECT 1 FROM service_requests WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid`);
  if (!req) return null;
  const [subs, missing] = await Promise.all([readRows(requestSubmissionsSql(org, rid)), readRows(missingRequiredFormsSql(org, rid))]);
  return {
    submissions: subs.map(toOfficeSubmission),
    missingRequired: missing.map((m) => ({ formId: String(m.id), name: String(m.name) })),
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/admin/form-queries.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/form-queries.ts src/lib/admin/form-queries.test.ts && npx vitest run
git add src/lib/admin/form-queries.ts src/lib/admin/form-queries.test.ts
git commit -m "$(cat <<'EOF'
feat(m3d): office form writers (officeId create, version CAS, archive), reopen, request answers + missing required

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 6: Erase widening (own commit), then photos under L_req and the erased-customer refusal

**Files:**
- Create: `src/lib/admin/erasure-sql.ts`, `src/lib/admin/erasure-sql.test.ts`, `src/lib/tech/photo-writes.ts`, `src/lib/tech/photo-writes.test.ts`
- Modify: `src/lib/admin/erasure-queries.ts`, `src/lib/admin/erasure-queries.test.ts` (harness gains `execute` + an `erasure-sql` mock; five existing cases updated: batch length 23 → 25, the attachments pre-read removed from the read indexes, the audit assertions), `src/lib/tech/field-queries.ts` (photo writer removed), `src/lib/tech/field-queries.test.ts` (its `addJobPhoto` block moves to `photo-writes.test.ts`), `src/app/api/tech/jobs/[id]/photo/route.ts`, `src/app/api/tech/jobs/[id]/photo/route.test.ts`

**Interfaces:**
- Consumes: `uuidArraySql` (Task 3), `lockRequestSql` / `readRows` / `runBatch`, `techCanReadSql` (`src/lib/tech/ownership.ts`), `TECH_UPLOAD_LIMIT_BYTES` / `FILE_TOO_LARGE_COPY` (Task 3).
- Produces: `eraseLockSql(org, cust)`, `attachmentMatchSql(org, cust, sessionIds)`, `eraseAuditSql(org, cust, sessionIds)`, `eraseAttachmentsSql(org, cust, sessionIds)` (… `RETURNING storage_key`), `eraseAnswersSql(org, cust)`; `anonymizeCustomer` batch = lock → audit (count in SQL) → attachments DELETE … RETURNING → the existing statements → answers UPDATE (after the `service_requests` UPDATE); R2 cleanup takes the returned keys plus the signature keys (the attachments pre-read is gone). `addJobPhoto(org, me, rid, input): { ok: true; id } | { ok: false; reason: "not_owned" | "customer_removed" }` from `src/lib/tech/photo-writes.ts` (ruling 7); the photo POST checks `isUuid`, refuses > 4 MB with "This file is too large. The limit is 4 MB.", and answers 409 `CUSTOMER_REMOVED` after deleting the uploaded object.

- [ ] **Step 1: Write the failing erase tests.** `src/lib/admin/erasure-sql.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { attachmentMatchSql, eraseAnswersSql, eraseAttachmentsSql, eraseAuditSql, eraseLockSql } from "./erasure-sql";

const ORG = "11111111-1111-4111-8111-111111111111";
const CUST = "22222222-2222-4222-8222-222222222222";
const S1 = "33333333-3333-4333-8333-333333333333";
const dialect = new PgDialect();
const q = (s: SQL) => dialect.sqlToQuery(s);
const text = (s: SQL) => q(s).sql.replace(/\s+/g, " ").trim();
const orgCount = (s: SQL) => q(s).params.filter((p) => p === ORG).length;

describe("erase statements (spec §4.5, §5.4)", () => {
  it("statement 0 locks every request of the customer in id order", () => {
    expect(text(eraseLockSql(ORG, CUST))).toBe(
      "SELECT 1 FROM service_requests WHERE organization_id = $1::uuid AND customer_id = $2::uuid ORDER BY id FOR NO KEY UPDATE",
    );
  });

  it("the attachment match covers customer, sessions, the customer's requests and their equipment (parenthesised)", () => {
    const s = attachmentMatchSql(ORG, CUST, [S1]);
    const t = text(s);
    expect(t.startsWith("(customer_id = $1::uuid OR session_id = ANY(ARRAY[$2::uuid]::uuid[])")).toBe(true);
    expect(t).toContain("OR service_request_id IN (SELECT id FROM service_requests WHERE organization_id = $3::uuid AND customer_id = $4::uuid)");
    expect(t).toContain("OR equipment_id IN (SELECT id FROM customer_equipment WHERE organization_id = $5::uuid AND customer_id = $6::uuid))");
    expect(text(attachmentMatchSql(ORG, CUST, []))).toContain("session_id = ANY(ARRAY[]::uuid[])");
  });

  it("the audit counts attachments in SQL with the same match; details hold counts only", () => {
    const s = eraseAuditSql(ORG, CUST, [S1]);
    const t = text(s);
    expect(t).toContain("VALUES ($1::uuid, NULL, 'customer_erased', 'customers', $2::uuid, json_build_object('sessions', $3::int, 'attachmentsDeleted', (SELECT count(*)::int FROM attachments WHERE organization_id = $4::uuid AND (customer_id = $5::uuid");
    expect(q(s).params).toContain(1);
    expect(orgCount(s)).toBe(4);
  });

  it("the attachments DELETE returns storage keys, org-bound", () => {
    const t = text(eraseAttachmentsSql(ORG, CUST, []));
    expect(t.startsWith("DELETE FROM attachments WHERE organization_id = $1::uuid AND (customer_id = $2::uuid")).toBe(true);
    expect(t.endsWith("RETURNING storage_key")).toBe(true);
  });

  it("answers: values NULL, erased_at set once; status, who and when kept", () => {
    const t = text(eraseAnswersSql(ORG, CUST));
    expect(t).toBe(
      "UPDATE form_submissions SET values_encrypted = NULL, erased_at = COALESCE(erased_at, now()), updated_at = now() WHERE organization_id = $1::uuid AND service_request_id IN (SELECT id FROM service_requests WHERE organization_id = $2::uuid AND customer_id = $3::uuid)",
    );
  });
});
```

Update the harness and cases in `src/lib/admin/erasure-queries.test.ts`:

```diff
diff --git a/src/lib/admin/erasure-queries.test.ts b/src/lib/admin/erasure-queries.test.ts
index ead8b33..707b76f 100644
--- a/src/lib/admin/erasure-queries.test.ts
+++ b/src/lib/admin/erasure-queries.test.ts
@@ -15,8 +15,10 @@ import { describe, it, expect, beforeEach, vi } from "vitest";
 
 // ── builder capture harness ────────────────────────────────────────────────
 interface Captured {
-  readonly op: "update" | "delete" | "insert";
+  readonly op: "update" | "delete" | "insert" | "execute";
   table: string;
+  /** M3d raw statements: the erasure-sql builder's arguments. */
+  args?: readonly unknown[];
   set?: Record<string, unknown>;
   values?: Record<string, unknown>;
   /** What .where(...) was given (the withTenant mock passes the conditions through). */
@@ -25,6 +27,7 @@ interface Captured {
 
 const {
   batchCalls,
+  attachmentReturn,
   insertCalls,
   selectQueue,
   selectWhereCalls,
@@ -33,6 +36,8 @@ const {
   makeInsert,
 } = vi.hoisted(() => {
     const batchCalls: Captured[][] = [];
+    // Rows the attachments DELETE … RETURNING storage_key hands back.
+    const attachmentReturn: { rows: { storage_key: string }[] } = { rows: [] };
     const insertCalls: Captured[] = [];
     const selectQueue: unknown[][] = [];
     // Records whatever each db.select(...).from(...).where(x) call was given,
@@ -82,6 +87,7 @@ const {
 
     return {
       batchCalls,
+      attachmentReturn,
       insertCalls,
       selectQueue,
       selectWhereCalls,
@@ -104,10 +110,10 @@ vi.mock("@/lib/db", () => ({
     update: (t: unknown) => makeUpdate(t),
     delete: (t: unknown) => makeDelete(t),
     insert: (t: unknown) => makeInsert(t),
+    execute: (q: { tag: string; args: unknown[] }): Captured => ({ op: "execute", table: q.tag, args: q.args }),
     batch: (stmts: Captured[]) => {
       batchCalls.push(stmts);
-      // Pull out any insert builders that recorded via .values() inside the batch
-      return Promise.resolve([]);
+      return Promise.resolve(stmts.map((c) => (c.table === "eraseAttachments" ? { rows: attachmentReturn.rows } : { rows: [] })));
     },
   },
 }));
@@ -148,6 +154,15 @@ vi.mock("@/lib/db/schema", () => {
   };
 });
 
+// M3d raw statements: tagged markers so the batch order and arguments are observable
+// (their SQL is rendered for real in erasure-sql.test.ts).
+vi.mock("@/lib/admin/erasure-sql", () => ({
+  eraseLockSql: (...args: unknown[]) => ({ tag: "eraseLock", args }),
+  eraseAuditSql: (...args: unknown[]) => ({ tag: "eraseAudit", args }),
+  eraseAttachmentsSql: (...args: unknown[]) => ({ tag: "eraseAttachments", args }),
+  eraseAnswersSql: (...args: unknown[]) => ({ tag: "eraseAnswers", args }),
+}));
+
 vi.mock("@/lib/db/tenant", () => ({
   withTenant: (_t: unknown, _org: string, ...c: unknown[]) => c,
 }));
@@ -222,6 +237,7 @@ function opFor(table: string): Captured | undefined {
 
 beforeEach(() => {
   batchCalls.length = 0;
+  attachmentReturn.rows = [];
   insertCalls.length = 0;
   selectQueue.length = 0;
   selectWhereCalls.length = 0;
@@ -240,7 +256,8 @@ describe("anonymizeCustomer", () => {
       { id: "req-1", signatureUrl: `${PUB}/signatures/req-1.png`, sessionId: "sess-1" },
       { id: "req-2", signatureUrl: null, sessionId: "sess-3" },
     ]); // service requests
-    selectQueue.push([{ storageKey: "k1" }, { storageKey: "k2" }]); // attachments
+    // The attachments DELETE … RETURNING storage_key (no pre-read since M3d).
+    attachmentReturn.rows = [{ storage_key: "k1" }, { storage_key: "k2" }];
     selectQueue.push([
       // The invoice's snapshot copy of req-1's signature (same object).
       { signatureUrl: `${PUB}/signatures/req-1.png` },
@@ -330,9 +347,10 @@ describe("anonymizeCustomer", () => {
     expect(appt?.set).toEqual({ specialInstructions: null });
     const batch = batchCalls.at(-1) ?? [];
     expect(batch.filter((c) => c.table === "appointments")).toHaveLength(1);
-    // 21 statements before visits #2+ existed; the appointments scrub is the
-    // 22nd; the invoice signature scrub (M3b) is the 23rd.
-    expect(batch).toHaveLength(23);
+    // 23 statements through M3c; M3d replaces the attachments delete and the
+    // audit insert with the lock, the SQL audit, the DELETE … RETURNING and
+    // the answers UPDATE: 25.
+    expect(batch).toHaveLength(25);
   });
 
   it("scrubs locations, sessions, comms, service history, and review feedback", async () => {
@@ -378,8 +396,8 @@ describe("anonymizeCustomer", () => {
     expect(sess?.cond).toEqual([["customerSessions.id", all]]);
     // Their transcripts go too (deduped union: sess-1 appears on both paths).
     expect(opFor("messages")?.cond).toEqual([["messages.sessionId", all]]);
-    const audit = opFor("auditLog");
-    expect(JSON.parse(String(audit?.values?.details))).toMatchObject({ sessions: 3 });
+    // The audit counts the deduped sessions (eraseAuditSql gets the full list).
+    expect(opFor("eraseAudit")?.args).toEqual([ORG, CUST, all]);
   });
 
   it("nulls session metadata + next steps and rewrites only sms: tokens", async () => {
@@ -409,17 +427,8 @@ describe("anonymizeCustomer", () => {
     seedExisting();
     await anonymizeCustomer(ORG, CUST);
     const batch = batchCalls.at(-1) ?? [];
-    const att = opFor("attachments");
-    expect(att?.cond).toEqual([
-      {
-        op: "or",
-        args: [
-          { op: "eq", args: ["attachments.customerId", CUST] },
-          ["attachments.sessionId", ["sess-1", "sess-2", "sess-3"]],
-        ],
-      },
-    ]);
-    expect(selectWhereCalls[3]).toEqual(att?.cond);
+    const att = opFor("eraseAttachments");
+    expect(att?.args).toEqual([ORG, CUST, ["sess-1", "sess-2", "sess-3"]]);
     expect(batch.indexOf(att!)).toBeLessThan(batch.indexOf(opFor("messages")!));
   });
 
@@ -439,7 +448,7 @@ describe("anonymizeCustomer", () => {
     await anonymizeCustomer(ORG, CUST);
     expect(opFor("messages")?.op).toBe("delete");
     expect(opFor("customerNotes")?.op).toBe("delete");
-    expect(opFor("attachments")?.op).toBe("delete");
+    expect(opFor("eraseAttachments")?.op).toBe("execute");
   });
 
   it("deletes follow-ups (reason is free-text PII)", async () => {
@@ -507,8 +516,8 @@ describe("anonymizeCustomer", () => {
   it("reads invoice signatures on the customer's invoices OR the customer's requests", async () => {
     seedExisting();
     await anonymizeCustomer(ORG, CUST);
-    // Reads: existence, sessions, requests, attachments, invoices.
-    const [invoiceMatch] = selectWhereCalls[4] as TaggedCondition[];
+    // Reads: existence, sessions, requests, invoices (the attachments pre-read is gone, M3d).
+    const [invoiceMatch] = selectWhereCalls[3] as TaggedCondition[];
     expect(invoiceMatch.op).toBe("or");
     expect(invoiceMatch.args).toHaveLength(2);
     expect(invoiceMatch.args[0]).toMatchObject({
@@ -536,15 +545,22 @@ describe("anonymizeCustomer", () => {
     expect(keys.some((k) => String(k).includes("://"))).toBe(false);
   });
 
-  it("audits with counts only — NO name/email/phone in the details", async () => {
+  it("audits with counts only — the SQL audit gets ids and the session list, never PII", async () => {
+    seedExisting();
+    await anonymizeCustomer(ORG, CUST);
+    expect(opFor("eraseAudit")?.args).toEqual([ORG, CUST, ["sess-1", "sess-2", "sess-3"]]);
+    expect(insertCalls.filter((c) => c.table === "auditLog")).toHaveLength(0);
+  });
+
+  it("M3d batch order: lock → audit → attachments DELETE → … → service_requests UPDATE → answers UPDATE", async () => {
     seedExisting();
     await anonymizeCustomer(ORG, CUST);
-    const audit = opFor("auditLog");
-    expect(audit?.values?.action).toBe("customer_erased");
-    const details = String(audit?.values?.details ?? "");
-    expect(details).not.toMatch(/@/); // no email
-    expect(details).toContain("sessions");
-    expect(details).toContain("attachmentsDeleted");
+    const batch = batchCalls.at(-1) ?? [];
+    expect(batch.slice(0, 3).map((c) => c.table)).toEqual(["eraseLock", "eraseAudit", "eraseAttachments"]);
+    expect(batch.at(-1)?.table).toBe("eraseAnswers");
+    expect(batch.indexOf(opFor("serviceRequests")!)).toBeLessThan(batch.length - 1);
+    expect(opFor("eraseAnswers")?.args).toEqual([ORG, CUST]);
+    expect(opFor("eraseLock")?.args).toEqual([ORG, CUST]);
   });
 
   it("schedules R2 cleanup of the collected storage keys via after()", async () => {
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/admin/erasure-sql.test.ts src/lib/admin/erasure-queries.test.ts`
Expected: FAIL — `./erasure-sql` unresolved; the batch has 23 statements, no `eraseLock` first.

- [ ] **Step 3: Implement the erase.** `src/lib/admin/erasure-sql.ts`:

```ts
/**
 * The raw statements M3d adds to the erase batch (spec §4.5, §5.4). Pure: drizzle
 * `sql` only, organization_id bound on every table reference.
 */
import { sql, type SQL } from "drizzle-orm";
import { uuidArraySql } from "@/lib/db/sql-arrays";

/** Statement 0: lock every request of the customer (request → rows, the writers' order). */
export function eraseLockSql(org: string, cust: string): SQL {
  return sql`SELECT 1 FROM service_requests WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid ORDER BY id FOR NO KEY UPDATE`;
}

const customerRequestIds = (org: string, cust: string): SQL =>
  sql`SELECT id FROM service_requests WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid`;

/**
 * The customer's attachments: their own (office uploads), chat uploads in their
 * sessions, files on their requests (technician photos and PDFs, office request
 * documents) and files on their equipment. Parenthesised: it holds ORs.
 */
export function attachmentMatchSql(org: string, cust: string, sessionIds: readonly string[]): SQL {
  return sql`(customer_id = ${cust}::uuid
    OR session_id = ANY(${uuidArraySql(sessionIds)})
    OR service_request_id IN (${customerRequestIds(org, cust)})
    OR equipment_id IN (SELECT id FROM customer_equipment WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid))`;
}

/** Statement 1: the audit row, counting the attachments in SQL (ids and counts only). */
export function eraseAuditSql(org: string, cust: string, sessionIds: readonly string[]): SQL {
  return sql`INSERT INTO audit_log (organization_id, user_id, action, entity, entity_id, details)
    VALUES (${org}::uuid, NULL, 'customer_erased', 'customers', ${cust}::uuid,
      json_build_object('sessions', ${sessionIds.length}::int,
        'attachmentsDeleted', (SELECT count(*)::int FROM attachments WHERE organization_id = ${org}::uuid AND ${attachmentMatchSql(org, cust, sessionIds)}))::text)`;
}

/** Statement 2: delete them, handing their storage keys to the after() cleanup. */
export function eraseAttachmentsSql(org: string, cust: string, sessionIds: readonly string[]): SQL {
  return sql`DELETE FROM attachments WHERE organization_id = ${org}::uuid AND ${attachmentMatchSql(org, cust, sessionIds)} RETURNING storage_key`;
}

/** Last statement: answers on the customer's requests go; status, who and when stay. */
export function eraseAnswersSql(org: string, cust: string): SQL {
  return sql`UPDATE form_submissions SET values_encrypted = NULL, erased_at = COALESCE(erased_at, now()), updated_at = now()
    WHERE organization_id = ${org}::uuid AND service_request_id IN (${customerRequestIds(org, cust)})`;
}
```

`src/lib/admin/erasure-queries.ts` (the `auditLog` import goes: the audit is now SQL):

```diff
diff --git a/src/lib/admin/erasure-queries.ts b/src/lib/admin/erasure-queries.ts
index c153c4d..4943ce9 100644
--- a/src/lib/admin/erasure-queries.ts
+++ b/src/lib/admin/erasure-queries.ts
@@ -52,7 +52,6 @@ import {
   requestNotes,
   customFieldValues,
   technicianTimeEntries,
-  auditLog,
   platformAuditLog,
   invoices,
 } from "@/lib/db/schema";
@@ -63,6 +62,7 @@ import { encrypt, decrypt } from "@/lib/crypto";
 import { getStorageClient } from "@/lib/storage/r2-client";
 import { storageKeyFromPublicUrl } from "@/lib/storage/storage-key";
 import { logger } from "@/lib/logger";
+import { eraseAnswersSql, eraseAttachmentsSql, eraseAuditSql, eraseLockSql } from "@/lib/admin/erasure-sql";
 
 /** Sentinel plaintext written into the two NOT NULL encrypted columns. */
 const DELETED_PLACEHOLDER = "[deleted]";
@@ -175,18 +175,6 @@ export async function anonymizeCustomer(
   ];
   const requestIds = requestRows.map((r) => r.id);
 
-  // Attachments: the customer's own (admin uploads) AND every chat upload in
-  // their sessions — those carry only session_id/message_id, and must go
-  // before the messages they point at (attachments.message_id FK).
-  const attachmentMatch = or(
-    eq(attachments.customerId, customerId),
-    inArray(attachments.sessionId, sessionIds),
-  )!;
-  const attachmentRows = await db
-    .select({ storageKey: attachments.storageKey })
-    .from(attachments)
-    .where(withTenant(attachments, organizationId, attachmentMatch));
-
   // Invoice signature snapshots (M3b): the customer's own invoices OR any
   // invoice on the customer's requests (an estimate-born invoice may carry a
   // different customer id). Read BEFORE the scrub so the objects can be deleted.
@@ -205,26 +193,20 @@ export async function anonymizeCustomer(
     .from(invoices)
     .where(withTenant(invoices, organizationId, invoiceSignatureMatch));
 
-  const attachmentKeys = attachmentRows.map((r) => r.storageKey);
-  const storageKeys = [
-    ...attachmentKeys,
-    ...signatureKeys([
-      ...requestRows.map((r) => r.signatureUrl),
-      ...invoiceSignatureRows.map((r) => r.signatureUrl),
-    ]),
-  ];
-
   const now = new Date();
 
   // ONE non-interactive atomic batch. All statements are tenant + customer
   // scoped. Deletes target the genuinely-personal child rows; everything else
   // is an order-independent UPDATE that nulls/scrubs PII in place.
-  await db.batch([
-    // Attachments first: a chat upload's message_id references a message
-    // deleted just below.
-    db
-      .delete(attachments)
-      .where(withTenant(attachments, organizationId, attachmentMatch)),
+  // M3d (spec §4.5, §5.4): statement 0 locks every request of the customer, so
+  // the audit count (1) and the attachments DELETE (2) see the same set and any
+  // in-flight form or photo writer has committed; the answers UPDATE runs last,
+  // after the service_requests UPDATE (request → rows, the writers' lock order).
+  const results = (await db.batch([
+    db.execute(eraseLockSql(organizationId, customerId)),
+    db.execute(eraseAuditSql(organizationId, customerId, sessionIds)),
+    // Attachments before the messages a chat upload's message_id references.
+    db.execute(eraseAttachmentsSql(organizationId, customerId, sessionIds)),
     // Delete chat transcript for this customer's sessions (PII free-text).
     // inArray over an empty list is a valid no-op (matches nothing).
     db
@@ -483,19 +465,18 @@ export async function anonymizeCustomer(
     db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "customer"), eq(entityTags.entityId, customerId))),
     db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "location"),
       inArray(entityTags.entityId, db.select({ id: customerLocations.id }).from(customerLocations).where(withTenant(customerLocations, organizationId, eq(customerLocations.customerId, customerId)))))),
-    // Audit: counts/table names ONLY — never name/email/phone.
-    db.insert(auditLog).values({
-      organizationId,
-      userId: null,
-      action: "customer_erased",
-      entity: "customers",
-      entityId: customerId,
-      details: JSON.stringify({
-        sessions: sessionIds.length,
-        attachmentsDeleted: attachmentKeys.length,
-      }),
-    }),
-  ]);
+    // M3d: form answers on the customer's requests (after the requests UPDATE).
+    db.execute(eraseAnswersSql(organizationId, customerId)),
+  ] as never)) as unknown as { rows?: { storage_key?: unknown }[] }[];
+
+  const attachmentKeys = (results[2]?.rows ?? []).map((r) => String(r.storage_key));
+  const storageKeys = [
+    ...attachmentKeys,
+    ...signatureKeys([
+      ...requestRows.map((r) => r.signatureUrl),
+      ...invoiceSignatureRows.map((r) => r.signatureUrl),
+    ]),
+  ];
 
   invalidateCustomerSearchCache(organizationId);
   scheduleStorageCleanup(storageKeys);
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/lib/admin/erasure-sql.test.ts src/lib/admin/erasure-queries.test.ts`
Expected: PASS (5 + 37).

- [ ] **Step 5: Commit the erase widening on its own** (spec §5.4: a revert of M3d must not revert it):

```bash
npx tsc --noEmit && npx eslint src/lib/admin/erasure-sql.ts src/lib/admin/erasure-sql.test.ts src/lib/admin/erasure-queries.ts src/lib/admin/erasure-queries.test.ts && npx vitest run
git add src/lib/admin/erasure-sql.ts src/lib/admin/erasure-sql.test.ts src/lib/admin/erasure-queries.ts src/lib/admin/erasure-queries.test.ts
git commit -m "$(cat <<'EOF'
fix(erase): lock the customer's requests first, erase request and equipment attachments, count them in SQL, erase form answers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

- [ ] **Step 6: Write the failing photo tests.** `src/lib/tech/photo-writes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, batch } = vi.hoisted(() => ({ readQueue: [] as unknown[][], batch: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => ({
      __sql: q,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
        Promise.resolve({ rows: readQueue.shift() ?? [] }).then(ok, err),
    }),
    batch,
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));

import { addJobPhoto } from "./photo-writes";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const photo = { filename: "before.jpg", mimeType: "image/jpeg", size: 1234, storageKey: "org/job/before.jpg" };
const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(((q as { __sql?: unknown }).__sql ?? q) as SQL).sql.replace(/\s+/g, " ").trim();
const rowsOf = (...r: unknown[][]) => r.map((rows) => ({ rows }));

beforeEach(() => { readQueue.length = 0; batch.mockReset(); });

describe("addJobPhoto (spec §5.4)", () => {
  it("one batch: L_req, then INSERT … SELECT with the read rule and the not-erased check", async () => {
    batch.mockResolvedValueOnce(rowsOf([], [{ id: "att-1" }]));
    expect(await addJobPhoto(ORG, ME, RID, photo)).toEqual({ ok: true, id: "att-1" });
    const [lock, insert] = (batch.mock.calls[0]![0] as unknown[]).map(render);
    expect(lock).toBe("SELECT 1 FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE");
    expect(insert).toMatch(/^INSERT INTO attachments \(organization_id, service_request_id, filename, mime_type, size, storage_key\) SELECT /);
    expect(insert).toContain("FROM appointment_assignments a JOIN appointments p");
    expect(insert).toContain("NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = service_requests.customer_id AND c.organization_id = $");
    expect(insert).toContain("c.anonymized_at IS NOT NULL) RETURNING id");
  });

  it("nothing written: an erased customer → customer_removed; unreadable → not_owned", async () => {
    batch.mockResolvedValueOnce(rowsOf([], []));
    readQueue.push([{ live: false }]);
    expect(await addJobPhoto(ORG, ME, RID, photo)).toEqual({ ok: false, reason: "customer_removed" });
    batch.mockResolvedValueOnce(rowsOf([], []));
    readQueue.push([]);
    expect(await addJobPhoto(ORG, ME, RID, photo)).toEqual({ ok: false, reason: "not_owned" });
  });
});
```

Replace `src/app/api/tech/jobs/[id]/photo/route.test.ts` (it now mocks `@/lib/tech/photo-writes` and adds the POST cases):

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { NextRequest } from "next/server";

const storage = vi.hoisted(() => ({
  validateFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  getSignedReadUrl: vi.fn(),
}));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/tech/field-queries", () => ({
  listJobPhotos: vi.fn(),
  isJobOwnedByTech: vi.fn(),
}));
vi.mock("@/lib/tech/photo-writes", () => ({ addJobPhoto: vi.fn() }));
vi.mock("@/lib/storage/r2-client", () => ({
  getStorageClient: vi.fn(() => storage),
  generateStorageKey: vi.fn(() => "org/job/before.jpg"),
  ADMIN_DOCUMENT_MIME_TYPES: [],
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { GET, POST } from "./route";
import { getTechSession } from "@/lib/auth/tech-session";
import { isJobOwnedByTech, listJobPhotos } from "@/lib/tech/field-queries";
import { addJobPhoto } from "@/lib/tech/photo-writes";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://t/api") as never;
const VALID_ID = "11111111-1111-1111-1111-111111111111";
const upload = (file: File | null) => {
  const fd = new FormData();
  if (file) fd.append("file", file);
  return new NextRequest(`http://localhost/api/tech/jobs/${VALID_ID}/photo`, { method: "POST", body: fd });
};
const jpeg = (bytes = 3) => new File([new Uint8Array(bytes)], "before.jpg", { type: "image/jpeg" });

beforeEach(() => {
  vi.clearAllMocks();
  (getTechSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
  storage.validateFile.mockReturnValue("image/jpeg");
  storage.uploadFile.mockResolvedValue(undefined);
  storage.deleteFile.mockResolvedValue(undefined);
});

describe("GET /api/tech/jobs/[id]/photo", () => {
  it("400 INVALID_ID for a non-UUID id, before any query", async () => {
    const res = await GET(req(), ctx("not-a-uuid") as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ID");
    expect(isJobOwnedByTech).not.toHaveBeenCalled();
  });

  it("404 when the job isn't the tech's", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(false);
    expect((await GET(req(), ctx(VALID_ID) as never)).status).toBe(404);
  });

  it("200 with no photos", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    (listJobPhotos as unknown as Mock).mockResolvedValue([]);
    const res = await GET(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(200);
    expect((await res.json()).data.photos).toEqual([]);
  });
});

describe("POST /api/tech/jobs/[id]/photo (M3d spec §7.7)", () => {
  it("400 INVALID_ID for a non-UUID id, before reading the body", async () => {
    const res = await POST(upload(jpeg()), ctx("nope") as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ID");
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it("refuses a file over 4 MB with the same copy as the phone", async () => {
    const res = await POST(upload(jpeg(4 * 1024 * 1024 + 1)), ctx(VALID_ID) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: { code: "INVALID_INPUT", message: "This file is too large. The limit is 4 MB." } });
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it("an erased customer: the upload is deleted and the answer is 409 CUSTOMER_REMOVED", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    (addJobPhoto as unknown as Mock).mockResolvedValue({ ok: false, reason: "customer_removed" });
    const res = await POST(upload(jpeg()), ctx(VALID_ID) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CUSTOMER_REMOVED");
    expect(storage.deleteFile).toHaveBeenCalledWith("org/job/before.jpg");
  });

  it("201 on success; 404 (and the upload deleted) when the job is no longer the tech's", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    (addJobPhoto as unknown as Mock).mockResolvedValueOnce({ ok: true, id: "att-1" });
    expect((await POST(upload(jpeg()), ctx(VALID_ID) as never)).status).toBe(201);
    (addJobPhoto as unknown as Mock).mockResolvedValueOnce({ ok: false, reason: "not_owned" });
    expect((await POST(upload(jpeg()), ctx(VALID_ID) as never)).status).toBe(404);
    expect(storage.deleteFile).toHaveBeenCalledTimes(1);
  });
});
```

Remove the moved block from `src/lib/tech/field-queries.test.ts`:

```diff
diff --git a/src/lib/tech/field-queries.test.ts b/src/lib/tech/field-queries.test.ts
index 6ec2915..cb42b78 100644
--- a/src/lib/tech/field-queries.test.ts
+++ b/src/lib/tech/field-queries.test.ts
@@ -6,7 +6,6 @@ import {
   removeJobMaterial,
   getActualMaterialsCostCents,
   getJobTimelineForTech,
-  addJobPhoto,
   listJobPhotos,
   recordSignature,
   isJobOwnedByTech,
@@ -352,43 +351,6 @@ describe("getJobTimelineForTech", () => {
   });
 });
 
-describe("addJobPhoto", () => {
-  const photo = {
-    filename: "before.jpg",
-    mimeType: "image/jpeg",
-    size: 12345,
-    storageKey: "org-1/job-1/before.jpg",
-  };
-
-  it("records the attachment for an owned job (linked to the service request)", async () => {
-    owned(true); // ownership guard → owned
-    const valuesSpy = vi.fn(() => ({
-      returning: () => Promise.resolve([{ id: "att-1" }]),
-    }));
-    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);
-
-    const r = await addJobPhoto(ORG, TECH, JOB, photo);
-    expect(r).toEqual({ ok: true, id: "att-1" });
-    expect(valuesSpy).toHaveBeenCalledWith(
-      expect.objectContaining({
-        organizationId: ORG,
-        serviceRequestId: JOB,
-        filename: "before.jpg",
-        mimeType: "image/jpeg",
-        size: 12345,
-        storageKey: "org-1/job-1/before.jpg",
-      }),
-    );
-  });
-
-  it("refuses a job not assigned to the tech (not_owned, no insert)", async () => {
-    owned(false); // ownership guard misses
-    const r = await addJobPhoto(ORG, "other-tech", JOB, photo);
-    expect(r).toEqual({ ok: false, reason: "not_owned" });
-    expect(db.insert).not.toHaveBeenCalled();
-  });
-});
-
 describe("recordSignature", () => {
   const SIG = { signatureUrl: "https://r2/sig.png", signatureName: "Jane Doe" };
   const dialect = new PgDialect();
```

- [ ] **Step 7: Run them to verify they fail**

Run: `npx vitest run src/lib/tech/photo-writes.test.ts "src/app/api/tech/jobs/[id]/photo"`
Expected: FAIL — `./photo-writes` unresolved; the route accepts a non-uuid id and a 4 MB + 1 file.

- [ ] **Step 8: Implement.** `src/lib/tech/photo-writes.ts`:

```ts
/**
 * Record a technician's job photo or PDF (M3d spec §5.4). ONE batch: L_req,
 * then an INSERT … SELECT that re-checks the read rule and refuses a request
 * whose customer was erased. Lives apart from field-queries.ts because it
 * needs `runBatch` / `lockRequestSql`, and invoice-field-writes.ts already
 * imports field-queries.ts.
 */
import { sql, type SQL } from "drizzle-orm";
import { lockRequestSql, readRows, runBatch } from "@/lib/admin/invoice-field-writes";
import { techCanReadSql } from "@/lib/tech/ownership";

export interface JobPhotoInput {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly storageKey: string;
}

export type AddJobPhotoResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: "not_owned" | "customer_removed" };

const NOT_ERASED = (org: string): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = service_requests.customer_id AND c.organization_id = ${org}::uuid AND c.anonymized_at IS NOT NULL)`;

export function jobPhotoInsertSql(org: string, me: string, rid: string, input: JobPhotoInput): SQL {
  return sql`INSERT INTO attachments (organization_id, service_request_id, filename, mime_type, size, storage_key)
    SELECT ${org}::uuid, service_requests.id, ${input.filename}, ${input.mimeType}, ${input.size}::int, ${input.storageKey}
    FROM service_requests
    WHERE service_requests.id = ${rid}::uuid AND service_requests.organization_id = ${org}::uuid
      AND ${techCanReadSql(org, me)} AND ${NOT_ERASED(org)}
    RETURNING id`;
}

export async function addJobPhoto(org: string, me: string, rid: string, input: JobPhotoInput): Promise<AddJobPhotoResult> {
  const out = await runBatch([lockRequestSql(org, rid), jobPhotoInsertSql(org, me, rid, input)]);
  if (Array.isArray(out) && out[1]![0]) return { ok: true, id: String(out[1]![0].id) };
  // Nothing written: say why (the route deletes the uploaded object either way).
  const [r] = await readRows(sql`SELECT ${NOT_ERASED(org)} AS live FROM service_requests
    WHERE service_requests.id = ${rid}::uuid AND service_requests.organization_id = ${org}::uuid AND ${techCanReadSql(org, me)}`);
  return { ok: false, reason: r && r.live === false ? "customer_removed" : "not_owned" };
}
```

Remove the old writer from `src/lib/tech/field-queries.ts` (its `JobPhotoInput`, `AddJobPhotoResult` and `addJobPhoto`; `listJobPhotos`, `attachments` and `findOwnedJob` stay in use):

```diff
diff --git a/src/lib/tech/field-queries.ts b/src/lib/tech/field-queries.ts
index 1e31434..a382bad 100644
--- a/src/lib/tech/field-queries.ts
+++ b/src/lib/tech/field-queries.ts
@@ -575,51 +578,7 @@ export async function getJobTimelineForTech(
   };
 }
 
-export interface JobPhotoInput {
-  readonly filename: string;
-  readonly mimeType: string;
-  readonly size: number;
-  readonly storageKey: string;
-}
-
-export type AddJobPhotoResult =
-  | { readonly ok: true; readonly id: string }
-  | { readonly ok: false; readonly reason: "not_owned" };
-
-/**
- * Record a job photo the tech uploaded. The file itself lives in R2 (uploaded by
- * the route); this stores the metadata in the shared `attachments` table linked
- * to the service request (the Stage-7 serviceRequestId link). Assignee + tenant
- * guarded — a tech may only attach to their OWN job.
- */
-export async function addJobPhoto(
-  organizationId: string,
-  techUserId: string,
-  serviceRequestId: string,
-  input: JobPhotoInput,
-): Promise<AddJobPhotoResult> {
-  const owned = await findOwnedJob(organizationId, techUserId, serviceRequestId);
-  if (!owned) {
-    return { ok: false, reason: "not_owned" };
-  }
-
-  const [created] = await db
-    .insert(attachments)
-    .values({
-      organizationId,
-      serviceRequestId,
-      filename: input.filename,
-      mimeType: input.mimeType,
-      size: input.size,
-      storageKey: input.storageKey,
-    })
-    .returning({ id: attachments.id });
-
-  if (!created) {
-    throw new Error("Failed to record job photo");
-  }
-  return { ok: true, id: created.id };
-}
+// addJobPhoto moved to src/lib/tech/photo-writes.ts (M3d: request lock + erased-customer refusal).
 
 export interface JobPhotoRow {
   readonly id: string;
```

The route:

```diff
diff --git a/src/app/api/tech/jobs/[id]/photo/route.ts b/src/app/api/tech/jobs/[id]/photo/route.ts
index 5c28ccd..6dd4c1d 100644
--- a/src/app/api/tech/jobs/[id]/photo/route.ts
+++ b/src/app/api/tech/jobs/[id]/photo/route.ts
@@ -6,15 +6,19 @@
  * to R2, then records the metadata in the shared attachments table linked to the
  * job. Ownership is enforced in addJobPhoto (assignee + tenant); on a non-assignee
  * we delete the orphaned upload and 404, keeping the guard authoritative in one
- * place — mirrors the signature route.
+ * place — mirrors the signature route. M3d: 4 MB cap (the phone resizes to it;
+ * Vercel caps bodies at 4.5 MB), uuid check on POST, and the insert runs under
+ * the request lock and refuses an erased customer (409 CUSTOMER_REMOVED, the
+ * uploaded object deleted).
  */
 import { NextRequest } from "next/server";
 import { getTechSession } from "@/lib/auth/tech-session";
-import { addJobPhoto, listJobPhotos, isJobOwnedByTech } from "@/lib/tech/field-queries";
+import { listJobPhotos, isJobOwnedByTech } from "@/lib/tech/field-queries";
+import { addJobPhoto } from "@/lib/tech/photo-writes";
+import { FILE_TOO_LARGE_COPY, TECH_UPLOAD_LIMIT_BYTES } from "@/lib/tech/upload-limits";
 import {
   getStorageClient,
   generateStorageKey,
-  MAX_DOCUMENT_FILE_SIZE,
   ADMIN_DOCUMENT_MIME_TYPES,
 } from "@/lib/storage/r2-client";
 import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
@@ -44,24 +48,30 @@ export async function POST(
     }
 
     const { id } = await params;
+    if (!isUuid(id)) {
+      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
+    }
 
     const formData = await request.formData();
     const file = formData.get("file");
     if (!(file instanceof File)) {
       return errorResponse("A photo file is required", "INVALID_INPUT", 400);
     }
+    if (file.size > TECH_UPLOAD_LIMIT_BYTES) {
+      return errorResponse(FILE_TOO_LARGE_COPY, "INVALID_INPUT", 400);
+    }
 
     const storageClient = getStorageClient();
     // HEIC is included so iPhone photos upload directly (the public JPEG/PNG-only
     // allowlist would reject them).
     const validatedMime = storageClient.validateFile(
       file,
-      MAX_DOCUMENT_FILE_SIZE,
+      TECH_UPLOAD_LIMIT_BYTES,
       ADMIN_DOCUMENT_MIME_TYPES,
     );
     if (!validatedMime) {
       return errorResponse(
-        "Invalid file. Allowed: JPEG, PNG, WEBP, HEIC, or PDF (max 20 MB).",
+        "Invalid file. Allowed: JPEG, PNG, WEBP, HEIC, or PDF (max 4 MB).",
         "INVALID_INPUT",
         400,
       );
@@ -86,9 +96,12 @@ export async function POST(
       storageKey,
     });
     if (!result.ok) {
-      // Race: job was reassigned between the ownership check and the write.
-      // Clean up the orphaned upload, then 404.
+      // Race: the job was reassigned, or its customer erased, between the
+      // ownership check and the write. Clean up the orphaned upload first.
       await storageClient.deleteFile(storageKey).catch(() => {});
+      if (result.reason === "customer_removed") {
+        return errorResponse("This job's customer was removed.", "CUSTOMER_REMOVED", 409);
+      }
       return errorResponse(
         "Job not found or not assigned to you",
         "NOT_FOUND",
```

- [ ] **Step 9: Run them to verify they pass**

Run: `npx vitest run src/lib/tech/photo-writes.test.ts "src/app/api/tech/jobs/[id]/photo" src/lib/tech/field-queries.test.ts`
Expected: PASS (2 + 7 + the field-queries file minus its two photo cases).

- [ ] **Step 10: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/photo-writes.ts src/lib/tech/photo-writes.test.ts src/lib/tech/field-queries.ts src/lib/tech/field-queries.test.ts "src/app/api/tech/jobs/[id]/photo/route.ts" "src/app/api/tech/jobs/[id]/photo/route.test.ts" && npx vitest run
git add src/lib/tech/photo-writes.ts src/lib/tech/photo-writes.test.ts src/lib/tech/field-queries.ts src/lib/tech/field-queries.test.ts "src/app/api/tech/jobs/[id]/photo/route.ts" "src/app/api/tech/jobs/[id]/photo/route.test.ts"
git commit -m "$(cat <<'EOF'
feat(m3d): job photos insert under the request lock, refuse an erased customer, 4 MB cap and uuid check on POST

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 7: Read models — the visit's forms, one form, the Site view

**Files:**
- Create: `src/lib/tech/form-view.ts`, `src/lib/tech/form-view.test.ts`, `src/lib/tech/form-reads.ts`, `src/lib/tech/form-reads.test.ts`, `src/lib/tech/site-view.ts`, `src/lib/tech/site-queries.ts`, `src/lib/tech/site-queries.test.ts`
- Modify: `src/lib/tech/ownership.ts` (`isActiveLead`, M3c's lead expression exported once), `src/lib/tech/ownership.test.ts`, `src/lib/tech/estimate-queries.ts` (uses it; behaviour unchanged)

**Interfaces:**
- Consumes: `findReadableJob`, `findActiveVisit`, `ActiveVisit` (`src/lib/tech/ownership.ts`); `readRows`; Task 3 `formAppliesSql`, `readFormGatesSql`, `toFormGates`, `visitCountsSql`, `writeBlockedReason`, `siteScopeOf`, `siteMatches`, `membershipEvaluable`, `normalizeAddress`, `uuidArraySql`; Task 4 `decryptValues`; `decrypt` (`src/lib/crypto.ts`); `issueLabel` (`src/lib/tech/job-display.ts`); `estimateLabel` (`src/lib/tech/estimate-display.ts`); `BUSINESS_BASE_LOCATION`.
- Produces:
  - `form-view.ts` (client-safe types + pure): `CardSubmission`, `SubmittedOn`, `CardForm`, `TechFormsView { visitId; visitNumber; myVisit; canWrite; writeBlockedReason; myRowCancelled; forms; otherForms }`, `TechFormSubmission`, `TechFormView { form { name; description; version; fields }; submission; submittedOn; myVisit; canWrite; writeBlockedReason; myRowCancelled }`, `buildFormsCard(visitId, forms, subs)`, `unsubmittedRequired(view)`.
  - `form-reads.ts`: `getJobForms(org, me, rid, aid): { kind: "not_found" } | { kind: "ok"; view: TechFormsView }`; `getJobForm(org, me, rid, formId, aid): { kind: "not_found" } | { kind: "archived" } | { kind: "ok"; view: TechFormView }`; SQL builders `countingVisitSql`, `cardFormsSql`, `cardSubmissionsSql`, `oneSubmissionSql`, `submittedElsewhereSql`.
  - `ownership.ts`: `isActiveLead(visit: ActiveVisit | null, me: string): boolean` (`visit?.leadTechnicianId === me`, the one lead rule; `getTechEstimatesView` now calls it).
  - `site-view.ts`: `SitePastJob { id; referenceNumber; date; status; kind; leadTechnicianName; submittedFormNames }`, `SiteEstimate`, `SiteMembership` (`member | none | withheld`), `SiteView { scope; title; pastJobs; unaddressedCount; openEstimates; membership; hasCustomer; isLead }`.
  - `site-queries.ts`: `getSiteView(org, me, rid): { kind: "not_found" } | { kind: "ok"; view: SiteView }`, `normalizedAddress(enc)`, SQL builders `siteSelfSql`, `candidatesSql`, `pastJobsSql`, `unaddressedSql`, `openEstimatesSql`, `allAddressesSql`, `membershipSql`, `upcomingVisitsSql`.

- [ ] **Step 1: Write the failing tests** — `src/lib/tech/form-view.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFormsCard, unsubmittedRequired, type FormRowIn, type SubmissionRowIn, type TechFormsView } from "./form-view";

const V1 = "visit-1";
const V2 = "visit-2";
const f = (id: string, over: Partial<FormRowIn> = {}): FormRowIn => ({ id, name: id, description: null, required: false, active: true, applies: true, ...over });
const s = (formId: string, appointmentId: string, over: Partial<SubmissionRowIn> = {}): SubmissionRowIn => ({
  id: `s-${formId}-${appointmentId}`, formId, appointmentId, appointmentNumber: appointmentId === V1 ? 1 : 2, status: "draft", revision: 1,
  hasAnswers: true, erased: false, updatedAt: "2026-11-07T10:00:00.000Z", submittedAt: null, submittedByName: null, visitCounts: true, ...over,
});

describe("buildFormsCard (spec §6, §7.2)", () => {
  it("lists active applicable forms plus forms with a row here; others go to otherForms", () => {
    const out = buildFormsCard(V2, [f("Applies"), f("Archived with row", { active: false }), f("Archived"), f("Other", { applies: false })].map((x) => (x.id === "Archived" ? { ...x, active: false } : x)), [s("Archived with row", V2)]);
    expect(out.forms.map((x) => x.formId)).toEqual(["Applies", "Archived with row"]);
    expect(out.otherForms).toEqual([{ formId: "Other", name: "Other" }]);
  });

  it("submittedOn = the newest submitted copy on another counting visit, only when this visit has none", () => {
    const sub = (at: string, over: Partial<SubmissionRowIn> = {}) => s("M", V1, { status: "submitted", submittedAt: at, ...over });
    const out = buildFormsCard(V2, [f("M")], [sub("2026-11-06T10:00:00.000Z")]);
    expect(out.forms[0]!.submittedOn).toEqual({ appointmentId: V1, appointmentNumber: 1, submittedAt: "2026-11-06T10:00:00.000Z" });
    expect(buildFormsCard(V2, [f("M")], [sub("2026-11-06T10:00:00.000Z", { visitCounts: false })]).forms[0]!.submittedOn).toBeNull();
    const both = buildFormsCard(V2, [f("M")], [sub("2026-11-06T10:00:00.000Z"), s("M", V2, { status: "submitted", submittedAt: "2026-11-07T10:00:00.000Z" })]);
    expect(both.forms[0]!.submittedOn).toBeNull();
    expect(both.forms[0]!.submission?.status).toBe("submitted");
  });

  it("orders required-and-not-submitted-anywhere first, then by name", () => {
    const out = buildFormsCard(V1, [f("b"), f("c", { required: true }), f("a", { required: true })], [s("a", V1, { status: "submitted", submittedAt: "2026-11-07T10:00:00.000Z" })]);
    expect(out.forms.map((x) => x.formId)).toEqual(["c", "a", "b"]);
  });
});

describe("unsubmittedRequired", () => {
  it("required forms with no submitted copy here or elsewhere", () => {
    const view = {
      forms: [
        { formId: "a", name: "A", description: null, required: true, submission: null, submittedOn: null },
        { formId: "b", name: "B", description: null, required: true, submission: null, submittedOn: { appointmentId: V1, appointmentNumber: 1, submittedAt: "x" } },
        { formId: "c", name: "C", description: null, required: false, submission: null, submittedOn: null },
      ],
    } as unknown as TechFormsView;
    expect(unsubmittedRequired(view)).toEqual([{ formId: "a", name: "A" }]);
    expect(unsubmittedRequired(null)).toEqual([]);
  });
});
```

`src/lib/tech/form-reads.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, executed } = vi.hoisted(() => ({ readQueue: [] as unknown[][], executed: [] as unknown[] }));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => {
      executed.push(q);
      return Promise.resolve({ rows: readQueue.shift() ?? [] });
    },
    batch: vi.fn(),
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));
vi.mock("@/lib/tech/ownership", async (orig) => ({ ...(await orig<typeof import("@/lib/tech/ownership")>()), findReadableJob: vi.fn() }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `ENC:${s}`,
  decrypt: (s: string) => {
    if (s === "BAD") throw new Error("auth tag");
    return s.slice(4);
  },
}));

import { cardFormsSql, cardSubmissionsSql, countingVisitSql, getJobForm, getJobForms, oneSubmissionSql, submittedElsewhereSql } from "./form-reads";
import { findReadableJob } from "@/lib/tech/ownership";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const AID = "44444444-4444-4444-8444-444444444444";
const FORM = "55555555-5555-4555-8555-555555555555";
const FIELDS = [{ id: "f_0000000001", type: "checkbox", label: "Filter", required: true }];
const T = "2026-11-07T14:41:00.000Z";
const gates = (over: Record<string, unknown> = {}) => ({
  status: "arrived", native: true, customer_erased: false, visit_found: true, visit_live: true, my_row: true, my_live_row: true,
  my_progress: false, form_found: true, form_active: true, form_version: 1, ...over,
});
const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.replace(/\s+/g, " ").trim();

beforeEach(() => {
  readQueue.length = 0;
  executed.length = 0;
  vi.mocked(findReadableJob).mockResolvedValue({ id: RID, customerId: null, native: true, status: "arrived" });
});

describe("getJobForms (spec §6)", () => {
  it("404 when the job isn't readable, the visit isn't the request's, or the visit doesn't count", async () => {
    vi.mocked(findReadableJob).mockResolvedValueOnce(null);
    expect(await getJobForms(ORG, ME, RID, AID)).toEqual({ kind: "not_found" });
    readQueue.push([]);
    expect(await getJobForms(ORG, ME, RID, AID)).toEqual({ kind: "not_found" });
    readQueue.push([{ id: AID, appointment_number: 1, counts: false }]);
    expect(await getJobForms(ORG, ME, RID, AID)).toEqual({ kind: "not_found" });
  });

  it("assembles the card; a reader with no row on the visit reads not_assigned", async () => {
    readQueue.push(
      [{ id: AID, appointment_number: 2, counts: true }],
      [gates({ my_row: false, my_live_row: false })],
      [{ id: FORM, name: "Maintenance checklist", description: null, required: true, active: true, applies: true }],
      [],
    );
    const r = await getJobForms(ORG, ME, RID, AID.toUpperCase());
    expect(r).toMatchObject({
      kind: "ok",
      view: { visitId: AID, visitNumber: 2, myVisit: false, canWrite: false, writeBlockedReason: "not_assigned", myRowCancelled: false },
    });
    if (r.kind === "ok") expect(r.view.forms.map((f) => f.name)).toEqual(["Maintenance checklist"]);
  });

  it("tenancy and request scope on every read (deleting a predicate fails here)", () => {
    const orgs = (s: SQL) => dialect.sqlToQuery(s).params.filter((p) => p === ORG).length;
    expect(orgs(cardFormsSql(ORG, RID))).toBe(2);
    expect(render(cardFormsSql(ORG, RID))).toContain("WHERE f.organization_id = $");
    expect(orgs(countingVisitSql(ORG, RID, AID))).toBe(3);
    expect(render(countingVisitSql(ORG, RID, AID))).toContain("WHERE p.id = $3::uuid AND p.service_request_id = $4::uuid AND p.organization_id = $5::uuid");
    expect(orgs(oneSubmissionSql(ORG, RID, AID, FORM))).toBe(3);
    expect(render(oneSubmissionSql(ORG, RID, AID, FORM))).toContain("AND s.service_request_id = $");
    expect(orgs(submittedElsewhereSql(ORG, RID, AID, FORM))).toBe(4);
    expect(render(submittedElsewhereSql(ORG, RID, AID, FORM))).toContain("AND s.service_request_id = $");
  });

  it("hasAnswers is values_encrypted IS NOT NULL (no decrypt); every table org-bound", () => {
    const t = render(cardSubmissionsSql(ORG, RID));
    expect(t).toContain("s.values_encrypted IS NOT NULL AS has_answers");
    expect(dialect.sqlToQuery(cardSubmissionsSql(ORG, RID)).params.filter((p) => p === ORG)).toHaveLength(5);
    expect(render(countingVisitSql(ORG, RID, AID))).toContain("WHERE p.id = $");
  });
});

describe("getJobForm (spec §6)", () => {
  it("a foreign or missing form id → 404; an archived form with no row → archived", async () => {
    readQueue.push([{ id: AID, appointment_number: 1, counts: true }], [gates()], [], []);
    expect(await getJobForm(ORG, ME, RID, FORM, AID)).toEqual({ kind: "not_found" });
    // The form is read inside the caller's org only: a foreign form id is a miss, never another org's form.
    const formRead = executed.map((q) => render(q)).find((t) => t.startsWith("SELECT name, description, version, fields, active FROM forms"));
    expect(formRead).toBe("SELECT name, description, version, fields, active FROM forms WHERE id = $1::uuid AND organization_id = $2::uuid");
    readQueue.push([{ id: AID, appointment_number: 1, counts: true }], [gates({ form_active: false })], [{ name: "M", description: null, version: 1, fields: FIELDS, active: false }], []);
    expect(await getJobForm(ORG, ME, RID, FORM, AID)).toEqual({ kind: "archived" });
  });

  it("renders the snapshot; decrypts; updatedByMe compares the caller", async () => {
    readQueue.push(
      [{ id: AID, appointment_number: 1, counts: true }],
      [gates()],
      [{ name: "Live name", description: "Desc", version: 3, fields: [], active: true }],
      [{ id: "s1", status: "draft", revision: 2, erased: false, form_name: "Snapshot name", form_version: 1, fields: FIELDS,
        values_encrypted: `ENC:${JSON.stringify({ f_0000000001: true })}`, updated_at: T, updated_by: ME, updated_by_name: "Sam Lee", submitted_at: null, submitted_by_name: null }],
      [],
    );
    const r = await getJobForm(ORG, ME, RID, FORM, AID);
    expect(r).toMatchObject({
      kind: "ok",
      view: {
        form: { name: "Snapshot name", description: "Desc", version: 1 },
        submission: { values: { f_0000000001: true }, updatedByMe: true, revision: 2 },
        canWrite: true, writeBlockedReason: null, submittedOn: null,
      },
    });
  });

  it("an undecryptable blob → values null, unreadable, never throws", async () => {
    readQueue.push(
      [{ id: AID, appointment_number: 1, counts: true }],
      [gates()],
      [{ name: "M", description: null, version: 1, fields: FIELDS, active: true }],
      [{ id: "s1", status: "draft", revision: 2, erased: false, form_name: "M", form_version: 1, fields: FIELDS, values_encrypted: "BAD", updated_at: T, updated_by: null }],
      [],
    );
    const r = await getJobForm(ORG, ME, RID, FORM, AID);
    expect(r).toMatchObject({ kind: "ok", view: { submission: { values: null }, canWrite: false, writeBlockedReason: "unreadable" } });
  });
});
```

`src/lib/tech/site-queries.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, executed } = vi.hoisted(() => ({ readQueue: [] as unknown[][], executed: [] as unknown[] }));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => {
      executed.push(q);
      return Promise.resolve({ rows: readQueue.shift() ?? [] });
    },
    batch: vi.fn(),
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));
vi.mock("@/lib/tech/ownership", async (orig) => ({
  ...(await orig<typeof import("@/lib/tech/ownership")>()),
  findReadableJob: vi.fn(),
  findActiveVisit: vi.fn(),
}));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `ENC:${s}`,
  decrypt: (s: string) => {
    if (s === "BAD") throw new Error("auth tag");
    return s.slice(4);
  },
  blindIndex: vi.fn(),
}));

import {
  allAddressesSql, candidatesSql, getSiteView, membershipSql, normalizedAddress, openEstimatesSql, pastJobsSql, siteSelfSql,
  unaddressedSql, upcomingVisitsSql,
} from "./site-queries";
import { findActiveVisit, findReadableJob } from "@/lib/tech/ownership";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const CUST = "44444444-4444-4444-8444-444444444444";
const LOC = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const ADDR = "ENC:12 Elm St, Johnson City, TN";
const dialect = new PgDialect();
const q = (s: SQL) => dialect.sqlToQuery(s);
const text = (s: SQL) => q(s).sql.replace(/\s+/g, " ").trim();
const orgCount = (s: SQL) => q(s).params.filter((p) => p === ORG).length;

beforeEach(() => {
  readQueue.length = 0;
  executed.length = 0;
  vi.mocked(findReadableJob).mockResolvedValue({ id: RID, customerId: CUST, native: true, status: "arrived" });
  vi.mocked(findActiveVisit).mockResolvedValue({ appointmentId: "a", leadTechnicianId: ME });
});

describe("site SQL binds the org on every table (spec §7.6)", () => {
  it("each builder", () => {
    expect(orgCount(siteSelfSql(ORG, RID))).toBe(3);
    expect(orgCount(candidatesSql(ORG, CUST, RID))).toBe(1);
    expect(orgCount(pastJobsSql(ORG, [OTHER]))).toBe(4);
    expect(orgCount(unaddressedSql(ORG, CUST, RID))).toBe(1);
    expect(orgCount(openEstimatesSql(ORG, [RID]))).toBe(2);
    expect(orgCount(allAddressesSql(ORG, CUST))).toBe(1);
    expect(orgCount(membershipSql(ORG, CUST))).toBe(2);
    expect(orgCount(upcomingVisitsSql(ORG, "m"))).toBe(1);
  });

  it("past jobs exclude unstarted future jobs and never select description, notes or contact columns", () => {
    const t = text(pastJobsSql(ORG, [OTHER]));
    expect(t).toContain("AND NOT (r.status IN ('pending'::request_status, 'assigned'::request_status, 'scheduled'::request_status) AND COALESCE(r.scheduled_date, r.arrival_window_start) > now())");
    expect(t).not.toMatch(/description|access_notes|address|phone|email|signature/);
    expect(t).toContain("LIMIT $");
  });

  it("estimates: open, unexpired, on the given requests only; upcoming visits from the start of today in the business timezone", () => {
    expect(text(openEstimatesSql(ORG, [RID]))).toContain("e.status = 'open'::estimate_status AND (e.expires_at IS NULL OR e.expires_at > now()) AND e.service_request_id = ANY(ARRAY[$");
    expect(text(upcomingVisitsSql(ORG, "m", "America/New_York"))).toContain("due_date >= (date_trunc('day', now() AT TIME ZONE $3) AT TIME ZONE $4)");
  });
});

describe("getSiteView", () => {
  it("no customer: none scope, this job's estimates still listed", async () => {
    vi.mocked(findReadableJob).mockResolvedValueOnce({ id: RID, customerId: null, native: false, status: "scheduled" });
    readQueue.push([{ customer_id: null, location_id: null, address_encrypted: null, customer_erased: false, location_label: null }], []);
    expect(await getSiteView(ORG, ME, RID)).toEqual({
      kind: "ok",
      view: { scope: "none", title: "Service address", unaddressedCount: 0, membership: { state: "none" }, hasCustomer: false, isLead: true, pastJobs: [], openEstimates: [] },
    });
  });

  it("location scope: matches feed past jobs and estimates; a second location withholds membership", async () => {
    readQueue.push(
      [{ customer_id: CUST, location_id: LOC, address_encrypted: ADDR, customer_erased: false, location_label: "Main house" }],
      [{ id: OTHER, location_id: LOC, address_encrypted: null }, { id: "x", location_id: null, address_encrypted: "ENC:40 Oak Ave" }],
      [{ n: 2 }],
      [{ id: OTHER, reference_number: "R-1", job_date: "2026-11-03T15:00:00Z", status: "completed", job_type_name: null, issue_type: "no_heat", lead_first_name: "Alex", form_names: ["Maintenance checklist"] }],
      [{ id: "e1", created_at: "2026-11-06T15:00:00Z", total_cents: 481200, title: null, from_fp: false, service_request_id: OTHER, option_count: 2 }],
      [{ n: 2 }],
      [{ address_encrypted: ADDR }],
    );
    const r = await getSiteView(ORG, ME, RID);
    expect(r).toMatchObject({
      kind: "ok",
      view: {
        scope: "location", title: "Main house", unaddressedCount: 2, membership: { state: "withheld" },
        pastJobs: [{ id: OTHER, kind: "No heat", leadTechnicianName: "Alex", submittedFormNames: ["Maintenance checklist"] }],
        openEstimates: [{ id: "e1", label: "Estimate · Nov 6 · 2 options", thisJob: false, fromFieldPulse: false }],
      },
    });
    expect(q(executed[4] as SQL).params).toEqual(expect.arrayContaining([RID, OTHER]));
  });

  it("member: one address everywhere and one location", async () => {
    readQueue.push(
      [{ customer_id: CUST, location_id: null, address_encrypted: ADDR, customer_erased: false, location_label: null }],
      [], [{ n: 0 }], [], [{ n: 1 }], [{ address_encrypted: ADDR }, { address_encrypted: "ENC:12  elm st, johnson city, tn" }],
      [{ id: "m1", started_at: "2026-03-01T00:00:00Z", current_period_end: null, plan_name: "Comfort Club", visits_per_year: 2 }],
      [{ due_date: "2027-05-01T12:00:00Z", status: "generated", generated_service_request_id: RID }],
    );
    const r = await getSiteView(ORG, ME, RID);
    expect(r).toMatchObject({ kind: "ok", view: { scope: "address", membership: { state: "member", planName: "Comfort Club", upcoming: [{ status: "generated", thisJob: true }] } } });
  });

  it("isLead comes from the shared lead rule (the active visit's lead), not from assigned_to", async () => {
    vi.mocked(findActiveVisit).mockResolvedValueOnce({ appointmentId: "a", leadTechnicianId: "someone-else" });
    readQueue.push([{ customer_id: null, location_id: null, address_encrypted: null, customer_erased: false, location_label: null }], []);
    expect(await getSiteView(ORG, ME, RID)).toMatchObject({ kind: "ok", view: { isLead: false } });
    vi.mocked(findActiveVisit).mockResolvedValueOnce(null);
    readQueue.push([{ customer_id: null, location_id: null, address_encrypted: null, customer_erased: false, location_label: null }], []);
    expect(await getSiteView(ORG, ME, RID)).toMatchObject({ kind: "ok", view: { isLead: false } });
  });

  it("normalizedAddress tolerates a rotated key", () => {
    expect(normalizedAddress("BAD")).toBeNull();
    expect(normalizedAddress("ENC:  12 Elm  St ")).toBe("12 elm st");
  });
});
```

`src/lib/tech/ownership.test.ts` (the shared lead rule):

```diff
diff --git a/src/lib/tech/ownership.test.ts b/src/lib/tech/ownership.test.ts
index 9dfb84c..84a8b4a 100644
--- a/src/lib/tech/ownership.test.ts
+++ b/src/lib/tech/ownership.test.ts
@@ -31,6 +31,7 @@ import {
   pickActiveVisit,
   techCanReadSql,
   type TechAssignmentRow,
+  isActiveLead,
 } from "./ownership";
 
 let n = 0;
@@ -179,3 +180,12 @@ describe("queries", () => {
     expect(await findActiveVisit("o", "j")).toEqual({ appointmentId: "appt-1", leadTechnicianId: "lead" });
   });
 });
+
+describe("isActiveLead (the one lead rule, shared by M3c's estimates GET and M3d's Site GET)", () => {
+  it("the caller leads the active visit; no visit or no lead is false", () => {
+    expect(isActiveLead({ appointmentId: "a", leadTechnicianId: "me" }, "me")).toBe(true);
+    expect(isActiveLead({ appointmentId: "a", leadTechnicianId: "other" }, "me")).toBe(false);
+    expect(isActiveLead({ appointmentId: "a", leadTechnicianId: null }, "me")).toBe(false);
+    expect(isActiveLead(null, "me")).toBe(false);
+  });
+});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/tech/form-view.test.ts src/lib/tech/form-reads.test.ts src/lib/tech/site-queries.test.ts src/lib/tech/ownership.test.ts`
Expected: FAIL — the three modules are unresolved; `isActiveLead` is not exported.

- [ ] **Step 3: Implement** — `src/lib/tech/form-view.ts`:

```ts
/**
 * Technician forms read model types and the pure card assembly (M3d spec §6,
 * §7.2). Client-safe: no db, no server-only imports.
 */
import type { FormField } from "@/lib/forms/form-schema";
import type { FormValues } from "@/lib/forms/form-values";
import type { WriteBlockedReason } from "@/lib/forms/form-gates";

export interface CardSubmission {
  readonly id: string;
  readonly status: "draft" | "submitted";
  readonly revision: number;
  readonly hasAnswers: boolean;
  readonly erased: boolean;
  readonly updatedAt: string;
  readonly submittedAt: string | null;
  readonly submittedByName: string | null;
}

export interface SubmittedOn {
  readonly appointmentId: string;
  readonly appointmentNumber: number;
  readonly submittedAt: string;
}

export interface CardForm {
  readonly formId: string;
  readonly name: string;
  readonly description: string | null;
  readonly required: boolean;
  readonly submission: CardSubmission | null;
  readonly submittedOn: SubmittedOn | null;
}

export interface TechFormsView {
  readonly visitId: string;
  readonly visitNumber: number;
  readonly myVisit: boolean;
  readonly canWrite: boolean;
  readonly writeBlockedReason: WriteBlockedReason | null;
  /** Lead ruling 9: the caller's row on this visit is cancelled (adds the "assign you again" line). */
  readonly myRowCancelled: boolean;
  readonly forms: readonly CardForm[];
  readonly otherForms: ReadonlyArray<{ readonly formId: string; readonly name: string }>;
}

export interface TechFormSubmission {
  readonly id: string;
  readonly status: "draft" | "submitted";
  readonly revision: number;
  /** null when erased or unreadable. */
  readonly values: FormValues | null;
  readonly updatedAt: string;
  readonly updatedByName: string | null;
  readonly updatedByMe: boolean;
  readonly submittedAt: string | null;
  readonly submittedByName: string | null;
  readonly erased: boolean;
}

export interface TechFormView {
  readonly form: { readonly name: string; readonly description: string | null; readonly version: number; readonly fields: readonly FormField[] };
  readonly submission: TechFormSubmission | null;
  readonly submittedOn: SubmittedOn | null;
  readonly myVisit: boolean;
  readonly canWrite: boolean;
  readonly writeBlockedReason: WriteBlockedReason | null;
  readonly myRowCancelled: boolean;
}

export interface FormRowIn {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly required: boolean;
  readonly active: boolean;
  readonly applies: boolean;
}

export interface SubmissionRowIn extends CardSubmission {
  readonly formId: string;
  readonly appointmentId: string;
  readonly appointmentNumber: number;
  readonly visitCounts: boolean;
}

/**
 * `forms` = active applicable forms + forms with a row on this visit;
 * `submittedOn` = the newest submitted copy on another visit that counts, when
 * this visit has no submitted row; order: required and not submitted anywhere
 * first, then name. `otherForms` = active forms not already listed.
 */
export function buildFormsCard(visitId: string, forms: readonly FormRowIn[], subs: readonly SubmissionRowIn[]): {
  forms: CardForm[];
  otherForms: { formId: string; name: string }[];
} {
  const here = new Map(subs.filter((s) => s.appointmentId === visitId).map((s) => [s.formId, s]));
  const listed = forms.filter((f) => (f.active && f.applies) || here.has(f.id));
  const card = listed.map((f): CardForm & { submittedAnywhere: boolean } => {
    const mine = here.get(f.id) ?? null;
    const others = subs
      .filter((s) => s.formId === f.id && s.appointmentId !== visitId && s.status === "submitted" && s.visitCounts && s.submittedAt !== null)
      .sort((a, b) => b.submittedAt!.localeCompare(a.submittedAt!));
    const submittedOn = mine?.status === "submitted" || others.length === 0
      ? null
      : { appointmentId: others[0]!.appointmentId, appointmentNumber: others[0]!.appointmentNumber, submittedAt: others[0]!.submittedAt! };
    const submission: CardSubmission | null = mine
      ? {
          id: mine.id, status: mine.status, revision: mine.revision, hasAnswers: mine.hasAnswers, erased: mine.erased,
          updatedAt: mine.updatedAt, submittedAt: mine.submittedAt, submittedByName: mine.submittedByName,
        }
      : null;
    return {
      formId: f.id, name: f.name, description: f.description, required: f.required, submission, submittedOn,
      submittedAnywhere: mine?.status === "submitted" || submittedOn !== null,
    };
  });
  card.sort((a, b) => {
    const ra = a.required && !a.submittedAnywhere ? 0 : 1;
    const rb = b.required && !b.submittedAnywhere ? 0 : 1;
    return ra - rb || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  const listedIds = new Set(listed.map((f) => f.id));
  return {
    forms: card.map(({ submittedAnywhere: _s, ...f }) => f),
    otherForms: forms.filter((f) => f.active && !listedIds.has(f.id)).map((f) => ({ formId: f.id, name: f.name })),
  };
}

/** Required forms on the card with no submitted copy on any visit that counts (the close-out reminder). */
export function unsubmittedRequired(view: TechFormsView | null): ReadonlyArray<{ formId: string; name: string }> {
  if (!view) return [];
  return view.forms
    .filter((f) => f.required && f.submission?.status !== "submitted" && f.submittedOn === null)
    .map((f) => ({ formId: f.formId, name: f.name }));
}
```

`src/lib/tech/form-reads.ts`:

```ts
/**
 * Technician form GETs (M3d spec §6): the visit's forms for the job page card,
 * and one form for the fill page. Read rule = findReadableJob; the visit must
 * belong to the request and count (spec §5.1), else not_found.
 */
import { sql, type SQL } from "drizzle-orm";
import { readRows } from "@/lib/admin/invoice-field-writes";
import { findReadableJob } from "@/lib/tech/ownership";
import { parseStoredFields } from "@/lib/forms/form-schema";
import {
  formAppliesSql, readFormGatesSql, toFormGates, visitCountsSql, writeBlockedReason, type FormGates,
} from "@/lib/forms/form-gates";
import { decryptValues } from "@/lib/tech/form-writes";
import { buildFormsCard, type SubmissionRowIn, type SubmittedOn, type TechFormsView, type TechFormView } from "@/lib/tech/form-view";

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

export function countingVisitSql(org: string, rid: string, aid: string): SQL {
  return sql`SELECT p.id, p.appointment_number, ${visitCountsSql(org, "p")} AS counts FROM appointments p
    WHERE p.id = ${aid}::uuid AND p.service_request_id = ${rid}::uuid AND p.organization_id = ${org}::uuid`;
}

export function cardFormsSql(org: string, rid: string): SQL {
  return sql`SELECT f.id, f.name, f.description, f.required, f.active, ${formAppliesSql("f", "r")} AS applies
    FROM forms f JOIN service_requests r ON r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
    WHERE f.organization_id = ${org}::uuid ORDER BY lower(f.name), f.id`;
}

export function cardSubmissionsSql(org: string, rid: string): SQL {
  return sql`SELECT s.id, s.form_id, s.appointment_id, p.appointment_number, s.status, s.revision,
      s.values_encrypted IS NOT NULL AS has_answers, s.erased_at IS NOT NULL AS erased, s.updated_at, s.submitted_at,
      su.name AS submitted_by_name, ${visitCountsSql(org, "p")} AS visit_counts
    FROM form_submissions s
    JOIN appointments p ON p.id = s.appointment_id AND p.organization_id = ${org}::uuid
    LEFT JOIN users su ON su.id = s.submitted_by AND su.organization_id = ${org}::uuid
    WHERE s.organization_id = ${org}::uuid AND s.service_request_id = ${rid}::uuid`;
}

function toSubmissionIn(r: Row): SubmissionRowIn {
  return {
    id: String(r.id),
    formId: String(r.form_id),
    appointmentId: String(r.appointment_id),
    appointmentNumber: Number(r.appointment_number),
    status: r.status === "submitted" ? "submitted" : "draft",
    revision: Number(r.revision),
    hasAnswers: r.has_answers === true,
    erased: r.erased === true,
    updatedAt: iso(r.updated_at),
    submittedAt: isoOrNull(r.submitted_at),
    submittedByName: strOrNull(r.submitted_by_name),
    visitCounts: r.visit_counts === true,
  };
}

type Visit = { id: string; number: number; gates: FormGates };

/** Readable job → the visit counts → the gate row. Null = 404. */
async function openVisit(org: string, me: string, rid: string, aid: string, formId: string | null): Promise<Visit | null> {
  if (!(await findReadableJob(org, me, rid))) return null;
  const [v] = await readRows(countingVisitSql(org, rid, aid));
  if (!v || v.counts !== true) return null;
  const gates = toFormGates((await readRows(readFormGatesSql(org, rid, aid, me, formId)))[0]);
  return gates ? { id: String(v.id), number: Number(v.appointment_number), gates } : null;
}

export type FormsResult = { kind: "not_found" } | { kind: "ok"; view: TechFormsView };

export async function getJobForms(org: string, me: string, rid: string, rawAid: string): Promise<FormsResult> {
  const aid = rawAid.toLowerCase();
  const visit = await openVisit(org, me, rid, aid, null);
  if (!visit) return { kind: "not_found" };
  const [forms, subs] = await Promise.all([readRows(cardFormsSql(org, rid)), readRows(cardSubmissionsSql(org, rid))]);
  const card = buildFormsCard(
    visit.id,
    forms.map((f) => ({
      id: String(f.id), name: String(f.name), description: strOrNull(f.description),
      required: f.required === true, active: f.active === true, applies: f.applies === true,
    })),
    subs.map(toSubmissionIn),
  );
  // Visit-level reason: a form with no row on an active form (archived is per form).
  const reason = writeBlockedReason({ ...visit.gates, formActive: true }, null);
  return {
    kind: "ok",
    view: {
      visitId: visit.id, visitNumber: visit.number, myVisit: visit.gates.myRow, canWrite: reason === null,
      writeBlockedReason: reason, myRowCancelled: visit.gates.myRow && !visit.gates.myLiveRow, ...card,
    },
  };
}

export function oneSubmissionSql(org: string, rid: string, aid: string, formId: string): SQL {
  return sql`SELECT s.id, s.status, s.revision, s.erased_at IS NOT NULL AS erased, s.form_name, s.form_version, s.fields, s.values_encrypted,
      s.updated_at, s.updated_by, uu.name AS updated_by_name, s.submitted_at, su.name AS submitted_by_name
    FROM form_submissions s
    LEFT JOIN users uu ON uu.id = s.updated_by AND uu.organization_id = ${org}::uuid
    LEFT JOIN users su ON su.id = s.submitted_by AND su.organization_id = ${org}::uuid
    WHERE s.organization_id = ${org}::uuid AND s.appointment_id = ${aid}::uuid AND s.form_id = ${formId}::uuid AND s.service_request_id = ${rid}::uuid`;
}

export function submittedElsewhereSql(org: string, rid: string, aid: string, formId: string): SQL {
  return sql`SELECT s.appointment_id, p.appointment_number, s.submitted_at FROM form_submissions s
    JOIN appointments p ON p.id = s.appointment_id AND p.organization_id = ${org}::uuid
    WHERE s.organization_id = ${org}::uuid AND s.service_request_id = ${rid}::uuid AND s.form_id = ${formId}::uuid
      AND s.status = 'submitted' AND s.appointment_id <> ${aid}::uuid AND ${visitCountsSql(org, "p")}
    ORDER BY s.submitted_at DESC LIMIT 1`;
}

export type FormResult = { kind: "not_found" } | { kind: "archived" } | { kind: "ok"; view: TechFormView };

export async function getJobForm(org: string, me: string, rid: string, rawFormId: string, rawAid: string): Promise<FormResult> {
  const aid = rawAid.toLowerCase();
  const formId = rawFormId.toLowerCase();
  const visit = await openVisit(org, me, rid, aid, formId);
  if (!visit) return { kind: "not_found" };
  const [[form], [row]] = await Promise.all([
    readRows(sql`SELECT name, description, version, fields, active FROM forms WHERE id = ${formId}::uuid AND organization_id = ${org}::uuid`),
    readRows(oneSubmissionSql(org, rid, aid, formId)),
  ]);
  if (!form) return { kind: "not_found" };
  if (!row && form.active !== true) return { kind: "archived" };

  const erased = row?.erased === true;
  const dec = row && !erased ? decryptValues(strOrNull(row.values_encrypted)) : null;
  const unreadable = dec === "unreadable";
  const status = row?.status === "submitted" ? "submitted" : "draft";
  let submittedOn: SubmittedOn | null = null;
  if (status !== "submitted" || !row) {
    const [o] = await readRows(submittedElsewhereSql(org, rid, aid, formId));
    if (o) submittedOn = { appointmentId: String(o.appointment_id), appointmentNumber: Number(o.appointment_number), submittedAt: iso(o.submitted_at) };
  }
  const reason = writeBlockedReason(visit.gates, row ? { status, erased, unreadable } : null);
  const fields = parseStoredFields(row ? row.fields : form.fields) ?? [];
  return {
    kind: "ok",
    view: {
      form: {
        name: String(row ? row.form_name : form.name),
        description: strOrNull(form.description),
        version: Number(row ? row.form_version : form.version),
        fields,
      },
      submission: row
        ? {
            id: String(row.id), status, revision: Number(row.revision),
            values: dec === null || dec === "unreadable" ? null : dec,
            updatedAt: iso(row.updated_at), updatedByName: strOrNull(row.updated_by_name),
            updatedByMe: String(row.updated_by ?? "") === me.toLowerCase(),
            submittedAt: isoOrNull(row.submitted_at), submittedByName: strOrNull(row.submitted_by_name), erased,
          }
        : null,
      submittedOn,
      myVisit: visit.gates.myRow,
      canWrite: reason === null,
      writeBlockedReason: reason,
      myRowCancelled: visit.gates.myRow && !visit.gates.myLiveRow,
    },
  };
}
```

`src/lib/tech/site-view.ts`:

```ts
/** Site page read model types (M3d spec §7.6). Client-safe. */
import type { SiteScope } from "@/lib/forms/site-scope";

export interface SitePastJob {
  readonly id: string;
  readonly referenceNumber: string;
  readonly date: string;
  readonly status: string;
  /** The job type's name, else the issue label. */
  readonly kind: string;
  /** First name only. */
  readonly leadTechnicianName: string | null;
  readonly submittedFormNames: readonly string[];
}

export interface SiteEstimate {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly totalCents: number;
  readonly optionCount: number;
  readonly thisJob: boolean;
  readonly fromFieldPulse: boolean;
}

export type SiteMembership =
  | {
      readonly state: "member";
      readonly planName: string;
      readonly startedAt: string;
      readonly currentPeriodEnd: string | null;
      readonly visitsPerYear: number;
      readonly upcoming: ReadonlyArray<{ readonly dueDate: string; readonly status: "scheduled" | "generated"; readonly thisJob: boolean }>;
    }
  | { readonly state: "none" }
  | { readonly state: "withheld" };

export interface SiteView {
  readonly scope: SiteScope;
  readonly title: string;
  readonly pastJobs: readonly SitePastJob[];
  readonly unaddressedCount: number;
  readonly openEstimates: readonly SiteEstimate[];
  readonly membership: SiteMembership;
  readonly hasCustomer: boolean;
  /** The caller leads the active visit (`isActiveLead`): only then are this job's open estimates links (spec §7.6). */
  readonly isLead: boolean;
}
```

`src/lib/tech/site-queries.ts`:

```ts
/**
 * The Site page read (M3d spec §7.6). Anchored on the readable request: the
 * customer, location and address come from service_requests server-side;
 * every table binds organization_id. Never the customer's jobs at another
 * address, never a guessed address; no description, notes, addresses, contact
 * fields or signature names leave this module.
 */
import { sql, type SQL } from "drizzle-orm";
import { readRows } from "@/lib/admin/invoice-field-writes";
import { normalizeAddress } from "@/lib/admin/location-queries";
import { decrypt } from "@/lib/crypto";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import { findActiveVisit, findReadableJob, isActiveLead } from "@/lib/tech/ownership";
import { issueLabel } from "@/lib/tech/job-display";
import { estimateLabel } from "@/lib/tech/estimate-display";
import { membershipEvaluable, siteMatches, siteScopeOf, type SiteCandidate, type SiteSelf } from "@/lib/forms/site-scope";
import type { SiteEstimate, SiteMembership, SitePastJob, SiteView } from "@/lib/tech/site-view";

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const CANDIDATE_CAP = 500;
const PAST_JOBS_CAP = 20;

/** Decrypt then normalise; a blob under a rotated key reads as "no address" (never throws). */
export function normalizedAddress(enc: unknown): string | null {
  if (typeof enc !== "string" || enc === "") return null;
  try {
    const n = normalizeAddress(decrypt(enc));
    return n === "" ? null : n;
  } catch {
    return null;
  }
}

export function siteSelfSql(org: string, rid: string): SQL {
  return sql`SELECT r.customer_id, r.location_id, r.address_encrypted, c.anonymized_at IS NOT NULL AS customer_erased, l.label AS location_label
    FROM service_requests r
    LEFT JOIN customers c ON c.id = r.customer_id AND c.organization_id = ${org}::uuid
    LEFT JOIN customer_locations l ON l.id = r.location_id AND l.organization_id = ${org}::uuid
    WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid`;
}

export function candidatesSql(org: string, cust: string, rid: string): SQL {
  return sql`SELECT id, location_id, address_encrypted FROM service_requests
    WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid AND id <> ${rid}::uuid AND status <> 'cancelled'::request_status
    ORDER BY created_at DESC, id LIMIT ${CANDIDATE_CAP}`;
}

export function pastJobsSql(org: string, ids: readonly string[]): SQL {
  return sql`SELECT r.id, r.reference_number, COALESCE(r.completed_at, r.scheduled_date, r.created_at) AS job_date, r.status::text AS status,
      jt.name AS job_type_name, r.issue_type, split_part(u.name, ' ', 1) AS lead_first_name,
      ARRAY(SELECT DISTINCT s.form_name FROM form_submissions s WHERE s.organization_id = ${org}::uuid AND s.service_request_id = r.id
        AND s.status = 'submitted' ORDER BY s.form_name LIMIT 3) AS form_names
    FROM service_requests r
    LEFT JOIN job_types jt ON jt.id = r.job_type_id AND jt.organization_id = ${org}::uuid
    LEFT JOIN users u ON u.id = r.assigned_to AND u.organization_id = ${org}::uuid
    WHERE r.organization_id = ${org}::uuid AND r.id = ANY(${uuidArraySql(ids)})
      AND NOT (r.status IN ('pending'::request_status, 'assigned'::request_status, 'scheduled'::request_status)
        AND COALESCE(r.scheduled_date, r.arrival_window_start) > now())
    ORDER BY COALESCE(r.completed_at, r.scheduled_date, r.created_at) DESC, r.id LIMIT ${PAST_JOBS_CAP}`;
}

export function unaddressedSql(org: string, cust: string, rid: string): SQL {
  return sql`SELECT count(*)::int AS n FROM service_requests
    WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid AND id <> ${rid}::uuid AND status <> 'cancelled'::request_status
      AND address_encrypted IS NULL AND location_id IS NULL`;
}

export function openEstimatesSql(org: string, requestIds: readonly string[]): SQL {
  return sql`SELECT e.id, e.created_at, e.total_cents, e.title, e.fieldpulse_estimate_id IS NOT NULL AS from_fp, e.service_request_id,
      (SELECT count(*)::int FROM estimate_options o WHERE o.estimate_id = e.id AND o.organization_id = ${org}::uuid) AS option_count
    FROM estimates e
    WHERE e.organization_id = ${org}::uuid AND e.status = 'open'::estimate_status AND (e.expires_at IS NULL OR e.expires_at > now())
      AND e.service_request_id = ANY(${uuidArraySql(requestIds)})
    ORDER BY e.created_at DESC, e.id`;
}

/** Every non-cancelled request of the customer, no cap (membership needs all of them). */
export function allAddressesSql(org: string, cust: string): SQL {
  return sql`SELECT address_encrypted FROM service_requests
    WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid AND status <> 'cancelled'::request_status`;
}

export function membershipSql(org: string, cust: string): SQL {
  return sql`SELECT m.id, m.started_at, m.current_period_end, pl.name AS plan_name, pl.visits_per_year
    FROM customer_memberships m JOIN membership_plans pl ON pl.id = m.plan_id AND pl.organization_id = ${org}::uuid
    WHERE m.organization_id = ${org}::uuid AND m.customer_id = ${cust}::uuid AND m.status = 'active'::membership_status
    ORDER BY m.started_at DESC LIMIT 1`;
}

/** Up to 3 scheduled / generated visits due from the start of today in the business timezone. */
export function upcomingVisitsSql(org: string, membershipId: string, timeZone: string = BUSINESS_BASE_LOCATION.timezone): SQL {
  return sql`SELECT due_date, status::text AS status, generated_service_request_id FROM membership_visits
    WHERE organization_id = ${org}::uuid AND customer_membership_id = ${membershipId}::uuid
      AND status IN ('scheduled'::membership_visit_status, 'generated'::membership_visit_status)
      AND due_date >= (date_trunc('day', now() AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone})
    ORDER BY due_date, id LIMIT 3`;
}

async function readMembership(org: string, cust: string, rid: string, selfAddress: string | null): Promise<SiteMembership> {
  if (selfAddress === null) return { state: "withheld" };
  const [[locs], all] = await Promise.all([
    readRows(sql`SELECT count(*)::int AS n FROM customer_locations WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid`),
    readRows(allAddressesSql(org, cust)),
  ]);
  if (!membershipEvaluable(selfAddress, Number(locs?.n ?? 0), all.map((r) => normalizedAddress(r.address_encrypted)))) {
    return { state: "withheld" };
  }
  const [m] = await readRows(membershipSql(org, cust));
  if (!m) return { state: "none" };
  const upcoming = await readRows(upcomingVisitsSql(org, String(m.id)));
  return {
    state: "member",
    planName: String(m.plan_name),
    startedAt: iso(m.started_at),
    currentPeriodEnd: m.current_period_end == null ? null : iso(m.current_period_end),
    visitsPerYear: Number(m.visits_per_year),
    upcoming: upcoming.map((v) => ({
      dueDate: iso(v.due_date),
      status: v.status === "generated" ? "generated" : "scheduled",
      thisJob: String(v.generated_service_request_id ?? "") === rid,
    })),
  };
}

function toPastJob(r: Row): SitePastJob {
  return {
    id: String(r.id),
    referenceNumber: String(r.reference_number),
    date: iso(r.job_date),
    status: String(r.status),
    kind: r.job_type_name ? String(r.job_type_name) : issueLabel(r.issue_type as string | null),
    leadTechnicianName: r.lead_first_name ? String(r.lead_first_name) : null,
    submittedFormNames: ((r.form_names as string[] | null) ?? []).slice(0, 3),
  };
}

function toEstimate(r: Row, rid: string): SiteEstimate {
  const fromFieldPulse = r.from_fp === true;
  const optionCount = Number(r.option_count);
  return {
    id: String(r.id),
    label: fromFieldPulse ? (r.title ? String(r.title) : "Estimate") : estimateLabel(r.created_at as string | Date, optionCount),
    createdAt: iso(r.created_at),
    totalCents: Number(r.total_cents),
    optionCount,
    thisJob: String(r.service_request_id) === rid,
    fromFieldPulse,
  };
}

export type SiteResult = { kind: "not_found" } | { kind: "ok"; view: SiteView };

export async function getSiteView(org: string, me: string, rawRid: string): Promise<SiteResult> {
  const rid = rawRid.toLowerCase();
  if (!(await findReadableJob(org, me, rid))) return { kind: "not_found" };
  const [[selfRow], visit] = await Promise.all([readRows(siteSelfSql(org, rid)), findActiveVisit(org, rid)]);
  if (!selfRow) return { kind: "not_found" };
  const isLead = isActiveLead(visit, me);
  const cust = selfRow.customer_id == null ? null : String(selfRow.customer_id);
  const self: SiteSelf = {
    hasCustomer: cust !== null,
    customerErased: selfRow.customer_erased === true,
    locationId: selfRow.location_id == null ? null : String(selfRow.location_id),
    address: normalizedAddress(selfRow.address_encrypted),
  };
  const title = selfRow.location_label ? String(selfRow.location_label) : "Service address";
  const scope = siteScopeOf(self);

  let matches: string[] = [];
  let unaddressedCount = 0;
  if (cust !== null && !self.customerErased) {
    const [cands, [un]] = await Promise.all([readRows(candidatesSql(org, cust, rid)), readRows(unaddressedSql(org, cust, rid))]);
    const candidates: SiteCandidate[] = cands.map((c) => ({
      id: String(c.id),
      locationId: c.location_id == null ? null : String(c.location_id),
      address: normalizedAddress(c.address_encrypted),
    }));
    matches = siteMatches(self, candidates);
    unaddressedCount = Number(un?.n ?? 0);
  }

  const [past, estimates, membership] = await Promise.all([
    matches.length > 0 ? readRows(pastJobsSql(org, matches)) : Promise.resolve([] as Row[]),
    readRows(openEstimatesSql(org, [rid, ...matches])),
    cust !== null && !self.customerErased ? readMembership(org, cust, rid, self.address) : Promise.resolve<SiteMembership>({ state: "none" }),
  ]);

  return {
    kind: "ok",
    view: {
      scope, title, unaddressedCount, membership, hasCustomer: cust !== null, isLead,
      pastJobs: past.map(toPastJob),
      openEstimates: estimates.map((e) => toEstimate(e, rid)),
    },
  };
}
```

Export the lead rule once (`src/lib/tech/ownership.ts`) and use it in M3c's estimates GET (`src/lib/tech/estimate-queries.ts`), so the Site GET doesn't copy it:

```diff
diff --git a/src/lib/tech/ownership.ts b/src/lib/tech/ownership.ts
index dec448b..54b9a07 100644
--- a/src/lib/tech/ownership.ts
+++ b/src/lib/tech/ownership.ts
@@ -33,6 +33,14 @@ export interface ActiveVisit {
   readonly leadTechnicianId: string | null;
 }
 
+/**
+ * The ONE "is the caller the lead" rule (M3c's estimates GET, M3d's Site GET):
+ * the lead of the request's active visit (pickActiveVisit).
+ */
+export function isActiveLead(visit: ActiveVisit | null, me: string): boolean {
+  return visit?.leadTechnicianId === me;
+}
+
 export function hasProgress(
   r: Pick<TechAssignmentRow, "enRouteAt" | "arrivedAt" | "startedAt" | "completedAt">,
 ): boolean {
```

```diff
diff --git a/src/lib/tech/estimate-queries.ts b/src/lib/tech/estimate-queries.ts
index ef6eb65..3ac908e 100644
--- a/src/lib/tech/estimate-queries.ts
+++ b/src/lib/tech/estimate-queries.ts
@@ -11,7 +11,7 @@ import { ERASED_PLACEHOLDER } from "@/lib/admin/report-format";
 import { errorCode, logger } from "@/lib/logger";
 import { P_LIVE, P_NATIVE } from "@/lib/admin/invoice-field-writes";
 import { billingInvoiceIdSql, jobBilledSql, officeBilledSql } from "@/lib/admin/estimate-billing-sql";
-import { findActiveVisit, findReadableJob } from "@/lib/tech/ownership";
+import { findActiveVisit, findReadableJob, isActiveLead } from "@/lib/tech/ownership";
 import { billingOf, createBlockedReason, derivedStatus, estimateLabel } from "@/lib/tech/estimate-display";
 import type { TechEstimate, TechEstimateOption, TechEstimatesView, TechJobInvoiceRef } from "@/lib/tech/estimate-view";
 
@@ -147,7 +147,7 @@ export async function getTechEstimatesView(
     companyNameOf(org),
     customerNameOf(org, job.customerId),
   ]);
-  const isLead = visit?.leadTechnicianId === me;
+  const isLead = isActiveLead(visit, me);
   const reason = createBlockedReason({ isLead, status: job.status, hasCustomer: job.customerId !== null });
   const estimates = assembleEstimates(estRows, optRows, lineRows, now);
   const inv = invRows[0];
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/lib/tech/form-view.test.ts src/lib/tech/form-reads.test.ts src/lib/tech/site-queries.test.ts src/lib/tech/ownership.test.ts src/lib/tech/estimate-queries.test.ts`
Expected: PASS (4 + 7 + 8 + ownership +1; the M3c estimate-queries suite unchanged).

- [ ] **Step 5: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/form-view.ts src/lib/tech/form-view.test.ts src/lib/tech/form-reads.ts src/lib/tech/form-reads.test.ts src/lib/tech/site-view.ts src/lib/tech/site-queries.ts src/lib/tech/site-queries.test.ts src/lib/tech/ownership.ts src/lib/tech/ownership.test.ts src/lib/tech/estimate-queries.ts && npx vitest run
git add src/lib/tech/form-view.ts src/lib/tech/form-view.test.ts src/lib/tech/form-reads.ts src/lib/tech/form-reads.test.ts src/lib/tech/site-view.ts src/lib/tech/site-queries.ts src/lib/tech/site-queries.test.ts src/lib/tech/ownership.ts src/lib/tech/ownership.test.ts src/lib/tech/estimate-queries.ts
git commit -m "$(cat <<'EOF'
feat(m3d): technician form read models (card, fill page) and the site view (location/address scope, membership states)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 8: Routes — form preamble, draft PUT, keyed submit, GETs, site, office settings and request routes

**Files:**
- Create: `src/lib/tech/form-route-guards.ts`, `src/lib/tech/form-route-guards.test.ts`, `src/lib/forms/form-bodies.ts`, `src/lib/tech/form-submit-hash.ts`, `src/lib/admin/form-route-copy.ts`, `src/app/api/tech/jobs/[id]/forms/route.ts`, `src/app/api/tech/jobs/[id]/forms/route.test.ts`, `src/app/api/tech/jobs/[id]/forms/[formId]/route.ts`, `src/app/api/tech/jobs/[id]/forms/[formId]/draft/route.ts`, `src/app/api/tech/jobs/[id]/forms/[formId]/submit/route.ts`, `src/app/api/tech/jobs/[id]/site/route.ts`, `src/app/api/tech/jobs/[id]/site/route.test.ts`, `src/app/api/admin/settings/forms/route.ts`, `src/app/api/admin/settings/forms/route.test.ts`, `src/app/api/admin/settings/forms/[id]/route.ts`, `src/app/api/admin/requests/[id]/forms/route.ts`, `src/app/api/admin/requests/[id]/forms/route.test.ts`, `src/app/api/admin/requests/[id]/forms/[submissionId]/reopen/route.ts`
- Create (dev tooling, used by this task's probe and by the walks of Tasks 9–11): `scripts/agent/m3d-walk.mts`
- Modify: `src/lib/rate-limit.ts` (`techFormDraft`), `src/lib/tech/invoice-route-guards.ts` (`frontGates` exported with `limit`)

**Interfaces:**
- Consumes: everything from Tasks 2–7; `readWriteBody`, `readKey`, `okResult` (`src/lib/tech/invoice-write-route.ts`); `withIdempotency`, `canonicalHash`, `toResponse` (`src/lib/http/idempotency.ts`); `macHex`, `canonicalJson` (Task 3); `logAudit`.
- Produces: `RATE_LIMITS.techFormDraft = { maxRequests: 60, windowMs: 60_000 }`; `frontGates(request, id, bucket, limit = RATE_LIMITS.adminMutation)`; `techFormFront(request, id, formId, bucket: "form" | "form-draft")`, `formGateFail(session, id, formId, appointmentId): Promise<FormWriteFail | null>`, `techFormGate(session, id, formId, appointmentId)` (the draft route runs `findDraftReplay` before it; the submit route runs `formGateFail` inside its keyed run, lead ruling 3); `draftBodySchema`, `submitBodySchema`, `SubmitBody`; `FORM_CHANGES_LABEL = "hvac-form-changes-v1"`, `submitHashInput(body)`; `createFormBodySchema`, `patchFormBodySchema`, `reopenBodySchema`, `FORM_OFFICE_COPY`; the HTTP contracts of spec §6 (plus `myRowCancelled`, ruling 9; PATCH body, ruling 8; Site `isLead`, ruling 12).

- [ ] **Step 1: Write the failing tests.** `src/lib/tech/form-route-guards.test.ts` (real rate limiter, reset per test):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ getTechSession: vi.fn(), findReadableJob: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute, batch: vi.fn() } }));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/session-csrf", () => ({ isSameOriginRequest: () => true }));
vi.mock("@/lib/tech/ownership", async (orig) => ({ ...(await orig<typeof import("@/lib/tech/ownership")>()), findReadableJob: h.findReadableJob }));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));

import { techFormFront, techFormGate } from "./form-route-guards";
import { resetRateLimitStore } from "@/lib/rate-limit";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const FORM = "44444444-4444-4444-8444-444444444444";
const AID = "abcdef00-0000-4000-8000-000000000000";
const SESSION = { userId: ME, organizationId: ORG, email: "t@x", name: "T", role: "technician" as const };
const req = () => new NextRequest(`http://localhost/api/tech/jobs/${RID}/forms/${FORM}/draft`, { method: "PUT" });
const gates = (over: Record<string, unknown> = {}) => ({
  status: "arrived", native: true, customer_erased: false, visit_found: true, visit_live: true, my_row: true, my_live_row: true,
  my_progress: false, form_found: true, form_active: true, form_version: 1, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitStore();
  h.getTechSession.mockResolvedValue(SESSION);
  h.findReadableJob.mockResolvedValue({ id: RID, customerId: null, native: true, status: "arrived" });
});

describe("techFormFront (spec §6)", () => {
  it("draft bucket: the 31st PUT in a minute passes, the 61st is 429", async () => {
    for (let i = 1; i <= 60; i++) expect((await techFormFront(req(), RID, FORM, "form-draft")).ok).toBe(true);
    const r = await techFormFront(req(), RID, FORM, "form-draft");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(429);
  });

  it("submit bucket keeps the 30/min write limit, separate from drafts", async () => {
    for (let i = 1; i <= 30; i++) expect((await techFormFront(req(), RID, FORM, "form")).ok).toBe(true);
    const r = await techFormFront(req(), RID, FORM, "form");
    if (!r.ok) expect(r.response.status).toBe(429);
    expect(r.ok).toBe(false);
    expect((await techFormFront(req(), RID, FORM, "form-draft")).ok).toBe(true);
  });

  it("a non-uuid form id is 400 INVALID_ID", async () => {
    const r = await techFormFront(req(), RID, "nope", "form-draft");
    expect(r.ok).toBe(false);
    if (!r.ok) expect((await r.response.json()).error.code).toBe("INVALID_ID");
  });
});

describe("techFormGate", () => {
  it("404 when the job isn't readable", async () => {
    h.findReadableJob.mockResolvedValueOnce(null);
    const r = await techFormGate(SESSION, RID, FORM, AID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(404);
  });

  it("maps the gate read: cancelled → 409 JOB_CLOSED; a cancelled visit → VISIT_ENDED; no row → 403 NOT_ASSIGNED", async () => {
    for (const [g, status, code] of [
      [gates({ status: "cancelled", visit_live: false }), 409, "JOB_CLOSED"],
      [gates({ visit_live: false }), 409, "VISIT_ENDED"],
      [gates({ my_row: false, my_live_row: false }), 403, "NOT_ASSIGNED"],
      [gates({ status: "scheduled" }), 409, "NOT_ON_SITE"],
      [gates({ customer_erased: true }), 409, "CUSTOMER_REMOVED"],
    ] as const) {
      h.execute.mockResolvedValueOnce({ rows: [g] });
      const r = await techFormGate(SESSION, RID, FORM, AID.toUpperCase());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(status);
        expect((await r.response.json()).error.code).toBe(code);
      }
    }
  });

  it("passes an on-site technician on the visit", async () => {
    h.execute.mockResolvedValueOnce({ rows: [gates()] });
    expect(await techFormGate(SESSION, RID, FORM, AID)).toEqual({ ok: true });
  });
});
```

`src/app/api/tech/jobs/[id]/forms/route.test.ts` (covers the list GET, the one-form GET, the draft PUT and the submit POST):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  getTechSession: vi.fn(),
  slidingWindow: vi.fn(),
  front: vi.fn(),
  gate: vi.fn(),
  gateFail: vi.fn(),
  replay: vi.fn(),
  getJobForms: vi.fn(),
  getJobForm: vi.fn(),
  save: vi.fn(),
  submit: vi.fn(),
  withIdempotency: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: h.slidingWindow }));
vi.mock("@/lib/tech/form-route-guards", () => ({ techFormFront: h.front, techFormGate: h.gate, formGateFail: h.gateFail }));
vi.mock("@/lib/tech/form-reads", () => ({ getJobForms: h.getJobForms, getJobForm: h.getJobForm }));
vi.mock("@/lib/tech/form-writes", () => ({ saveFormDraft: h.save, submitForm: h.submit, findDraftReplay: h.replay }));
vi.mock("@/lib/crypto", () => ({ macHex: (label: string, v: string) => `mac(${label}:${v.length})` }));
vi.mock("@/lib/http/idempotency", async (orig) => ({ ...(await orig<typeof import("@/lib/http/idempotency")>()), withIdempotency: h.withIdempotency }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, errorCode: () => "x" }));

import { GET as LIST } from "./route";
import { GET as ONE } from "./[formId]/route";
import { PUT as DRAFT } from "./[formId]/draft/route";
import { POST as SUBMIT } from "./[formId]/submit/route";
import { submitHashInput } from "@/lib/tech/form-submit-hash";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const FORM = "22222222-2222-4222-8222-222222222222";
const AID = "33333333-3333-4333-8333-333333333333";
const SAVE = "44444444-4444-4444-8444-444444444444";
const SECRET = "Basement door code 4471";
const base = `http://localhost/api/tech/jobs/${RID}/forms`;
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: unknown } };
const body = (over: Record<string, unknown> = {}) => ({ appointmentId: AID, formVersion: 1, baseRevision: 0, changes: { f_0000000001: SECRET }, ...over });
const put = (b: unknown) => DRAFT(new NextRequest(`${base}/${FORM}/draft`, { method: "PUT", body: JSON.stringify(b) }), { params: Promise.resolve({ id: RID, formId: FORM }) });
const post = (b: unknown, key: string | null = "k-1") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return SUBMIT(new NextRequest(`${base}/${FORM}/submit`, { method: "POST", headers, body: JSON.stringify(b) }), { params: Promise.resolve({ id: RID, formId: FORM }) });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getTechSession.mockResolvedValue({ userId: U, organizationId: ORG });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.front.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG } });
  h.gate.mockResolvedValue({ ok: true });
  h.gateFail.mockResolvedValue(null);
  h.replay.mockResolvedValue(null);
  h.withIdempotency.mockImplementation(async (_s: unknown, _h: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    ({ ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false }));
});

describe("GET …/forms and …/forms/[formId]", () => {
  it("401 / 400 (bad visit) / 429 / 404 / 200", async () => {
    const list = (visit: string) => LIST(new NextRequest(`${base}?visit=${visit}`), { params: Promise.resolve({ id: RID }) });
    h.getTechSession.mockResolvedValueOnce(null);
    expect((await list(AID)).status).toBe(401);
    expect((await list("nope")).status).toBe(400);
    h.slidingWindow.mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 1 });
    expect((await list(AID)).status).toBe(429);
    expect(h.slidingWindow).toHaveBeenLastCalledWith(`tech:form:read:${U}`, 60, 60_000);
    h.getJobForms.mockResolvedValueOnce({ kind: "not_found" });
    expect((await list(AID)).status).toBe(404);
    h.getJobForms.mockResolvedValueOnce({ kind: "ok", view: { visitId: AID, forms: [] } });
    expect(await json(await list(AID))).toEqual({ success: true, data: { visitId: AID, forms: [] } });
  });

  it("one form: a foreign form id is 404; archived with no row is 409 FORM_ARCHIVED", async () => {
    const one = () => ONE(new NextRequest(`${base}/${FORM}?visit=${AID}`), { params: Promise.resolve({ id: RID, formId: FORM }) });
    h.getJobForm.mockResolvedValueOnce({ kind: "not_found" });
    expect(await json(await one())).toMatchObject({ error: { code: "NOT_FOUND", message: "This form is no longer on this job." } });
    h.getJobForm.mockResolvedValueOnce({ kind: "archived" });
    const a = await one();
    expect(a.status).toBe(409);
    expect((await json(a)).error?.code).toBe("FORM_ARCHIVED");
  });
});

describe("PUT …/draft (spec §4.2)", () => {
  it("the front refusal comes first, before the body is read", async () => {
    h.front.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ success: false, error: { code: "RATE_LIMITED" } }, { status: 429 }) });
    expect((await put(body({ saveId: SAVE }))).status).toBe(429);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("a body without saveId is 400 INVALID_INPUT; the gate runs with the body's visit", async () => {
    expect((await put(body())).status).toBe(400);
    h.save.mockResolvedValueOnce({ ok: true, submissionId: "s", revision: 1, savedAt: "t", created: true });
    expect((await put(body({ saveId: SAVE }))).status).toBe(201);
    expect(h.gate).toHaveBeenCalledWith({ userId: U, organizationId: ORG }, RID, FORM, AID);
    h.save.mockResolvedValueOnce({ ok: true, submissionId: "s", revision: 2, savedAt: "t", created: false });
    const r = await put(body({ saveId: SAVE, baseRevision: 1 }));
    expect([r.status, (await json(r)).data]).toEqual([200, { submissionId: "s", revision: 2, savedAt: "t" }]);
  });

  it("a retry of a landed write replays BEFORE the gates (spec §4.2 replay first)", async () => {
    h.replay.mockResolvedValueOnce({ ok: true, submissionId: "s", revision: 4, savedAt: "t", created: false });
    const r = await put(body({ saveId: SAVE, baseRevision: 3 }));
    expect([r.status, (await json(r)).data]).toEqual([200, { submissionId: "s", revision: 4, savedAt: "t" }]);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("refusals map to codes with id / revision / path details only", async () => {
    h.save.mockResolvedValueOnce({ ok: false, reason: "stale", revision: 7 });
    expect(await json(await put(body({ saveId: SAVE })))).toEqual({
      success: false, error: { code: "STALE", message: "Someone else changed this form.", details: { revision: 7 } },
    });
    h.save.mockResolvedValueOnce({ ok: false, reason: "values_too_large" });
    expect((await json(await put(body({ saveId: SAVE })))).error?.details).toEqual({ path: ["values"] });
  });
});

describe("POST …/submit (spec §4.3)", () => {
  it("needs an idempotency key", async () => {
    expect((await json(await post(body(), null))).error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("passes the derived submit key; neither the hash input nor a stored envelope holds a submitted string", async () => {
    h.submit.mockResolvedValueOnce({ ok: false, reason: "form_incomplete", fieldIds: ["f_0000000002"] });
    const r = await post(body());
    expect(r.status).toBe(400);
    const envelope = await json(r);
    expect(envelope.error?.code).toBe("FORM_INCOMPLETE");
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
    expect(h.submit.mock.calls[0]![2]).toEqual({ submitKey: "derived-form-submit" });
    const hashInput = submitHashInput(body() as never);
    expect(JSON.stringify(hashInput)).not.toContain(SECRET);
    expect(hashInput).toEqual({ appointmentId: AID, formVersion: 1, baseRevision: 0, changesMac: expect.stringMatching(/^mac\(hvac-form-changes-v1:/) });
  });

  it("the gates run inside the keyed run: a closed job refuses (unstored) without calling the writer", async () => {
    h.gateFail.mockResolvedValueOnce({ ok: false, reason: "job_closed" });
    const r = await post(body());
    expect([r.status, (await json(r)).error?.code]).toEqual([409, "JOB_CLOSED"]);
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.gateFail).toHaveBeenCalledWith({ userId: U, organizationId: ORG }, RID, FORM, AID);
  });

  it("success is 200 { submissionId, revision, submittedAt }", async () => {
    h.submit.mockResolvedValueOnce({ ok: true, submissionId: "s", revision: 3, submittedAt: "t" });
    const r = await post(body());
    expect([r.status, (await json(r)).data]).toEqual([200, { submissionId: "s", revision: 3, submittedAt: "t" }]);
  });
});
```

`src/app/api/tech/jobs/[id]/site/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ getTechSession: vi.fn(), slidingWindow: vi.fn(), getSiteView: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: h.slidingWindow }));
vi.mock("@/lib/tech/site-queries", () => ({ getSiteView: h.getSiteView }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() }, errorCode: () => "x" }));

import { GET } from "./route";

const RID = "11111111-1111-4111-8111-111111111111";
const get = (id = RID) => GET(new NextRequest(`http://localhost/api/tech/jobs/${id}/site`), { params: Promise.resolve({ id }) });
const VIEW = {
  scope: "location", title: "Main house", unaddressedCount: 1, hasCustomer: true, isLead: true,
  pastJobs: [{ id: "r1", referenceNumber: "R-1", date: "2026-11-03T15:00:00.000Z", status: "completed", kind: "Maintenance", leadTechnicianName: "Alex", submittedFormNames: ["Maintenance checklist"] }],
  openEstimates: [{ id: "e1", label: "Estimate · Nov 6 · 2 options", createdAt: "2026-11-06T15:00:00.000Z", totalCents: 481200, optionCount: 2, thisJob: true, fromFieldPulse: false }],
  membership: { state: "member", planName: "Comfort Club", startedAt: "2026-03-01T00:00:00.000Z", currentPeriodEnd: null, visitsPerYear: 2, upcoming: [] },
};

function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k.toLowerCase()); keysDeep(x, out); }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getTechSession.mockResolvedValue({ userId: "u", organizationId: "o" });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
});

describe("GET /api/tech/jobs/[id]/site (spec §7.6)", () => {
  it("401 / 400 / 429 / 404", async () => {
    h.getTechSession.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    expect((await get("nope")).status).toBe(400);
    h.slidingWindow.mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 1 });
    expect((await get()).status).toBe(429);
    expect(h.slidingWindow).toHaveBeenLastCalledWith("tech:site:read:u", 60, 60_000);
    h.getSiteView.mockResolvedValueOnce({ kind: "not_found" });
    expect((await get()).status).toBe(404);
  });

  it("the payload has no key like phone, email, description, address or signature", async () => {
    h.getSiteView.mockResolvedValueOnce({ kind: "ok", view: VIEW });
    const res = await get();
    const keys = keysDeep(await res.json());
    // Substring rule (spec §9); the spec's own `unaddressedCount` is the one allowed key (lead ruling 12).
    expect(keys.filter((k) => k !== "unaddressedcount" && /phone|email|description|address|signature/.test(k))).toEqual([]);
    expect(keys).toContain("unaddressedcount");
  });
});
```

`src/app/api/admin/settings/forms/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getAdminSession: vi.fn(), slidingWindow: vi.fn(), logAudit: vi.fn(),
  listForms: vi.fn(), createForm: vi.fn(), getForm: vi.fn(), updateForm: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/session", () => ({ getAdminSession: h.getAdminSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: h.slidingWindow }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/admin/form-queries", () => ({ listForms: h.listForms, createForm: h.createForm, getForm: h.getForm, updateForm: h.updateForm }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() }, errorCode: () => "x" }));

import { GET as LIST, POST as CREATE } from "./route";
import { GET as ONE, PATCH } from "./[id]/route";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const FID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const DEF = {
  name: "Maintenance checklist", description: null, jobTypeIds: [], required: true,
  fields: [{ id: "f_0000000001", type: "checkbox", label: "Filter changed", required: true }],
};
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: unknown } };
const create = (b: unknown) => CREATE(new NextRequest("http://localhost/api/admin/settings/forms", { method: "POST", body: JSON.stringify(b) }));
const patch = (b: unknown, id = FID) => PATCH(new NextRequest(`http://localhost/api/admin/settings/forms/${id}`, { method: "PATCH", body: JSON.stringify(b) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.getAdminSession.mockResolvedValue({ userId: U, organizationId: ORG, role: "admin" });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.logAudit.mockResolvedValue(undefined);
});

describe("GET/POST /api/admin/settings/forms (spec §4.1, §6)", () => {
  it("lists forms for the admin's org", async () => {
    h.listForms.mockResolvedValueOnce([]);
    expect(await json(await LIST())).toEqual({ success: true, data: { forms: [] } });
    expect(h.listForms).toHaveBeenCalledWith(ORG);
  });

  it("201 on create with a form_created audit (ids only); 200 replay with no audit", async () => {
    h.createForm.mockResolvedValueOnce({ ok: true, id: FID, created: true });
    const r = await create({ ...DEF, clientToken: TOKEN });
    expect([r.status, (await json(r)).data]).toEqual([201, { id: FID }]);
    expect(h.createForm).toHaveBeenCalledWith(ORG, U, TOKEN, DEF);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "form_created", entityId: FID, details: JSON.stringify({ formId: FID }) }));
    h.createForm.mockResolvedValueOnce({ ok: true, id: FID, created: false });
    expect((await create({ ...DEF, clientToken: TOKEN })).status).toBe(200);
    expect(h.logAudit).toHaveBeenCalledTimes(1);
  });

  it("an empty definition is 400 VALIDATION_ERROR with a path, and nothing is created", async () => {
    const r = await create({ ...DEF, fields: [{ id: "f_0000000001", type: "heading", label: "H", required: false }], clientToken: TOKEN });
    expect(await json(r)).toEqual({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid form", details: { path: ["fields"] } } });
    expect(h.createForm).not.toHaveBeenCalled();
  });

  it("NAME_TAKEN / LIMIT_REACHED / UNKNOWN_JOB_TYPE", async () => {
    for (const [reason, status, code] of [["name_taken", 409, "NAME_TAKEN"], ["limit_reached", 409, "LIMIT_REACHED"], ["unknown_job_type", 400, "UNKNOWN_JOB_TYPE"]] as const) {
      h.createForm.mockResolvedValueOnce({ ok: false, reason });
      const r = await create({ ...DEF, clientToken: TOKEN });
      expect([r.status, (await json(r)).error?.code]).toEqual([status, code]);
    }
  });
});

describe("GET/PATCH /api/admin/settings/forms/[id]", () => {
  it("a foreign or missing id is 404; a non-uuid is 400", async () => {
    h.getForm.mockResolvedValueOnce(null);
    expect((await ONE(new NextRequest("http://x"), { params: Promise.resolve({ id: FID }) })).status).toBe(404);
    expect(h.getForm).toHaveBeenCalledWith(ORG, FID);
    expect((await ONE(new NextRequest("http://x"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(400);
  });

  it("definition PATCH audits form_updated with version and fieldCount; archive audits form_archived", async () => {
    h.updateForm.mockResolvedValueOnce({ ok: true, version: 3 });
    expect(await json(await patch({ version: 2, definition: DEF }))).toEqual({ success: true, data: { version: 3 } });
    expect(h.logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "form_updated", details: JSON.stringify({ formId: FID, version: 3, fieldCount: 1 }) }));
    h.updateForm.mockResolvedValueOnce({ ok: true, version: 4 });
    await patch({ version: 3, active: false });
    expect(h.logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "form_archived", details: JSON.stringify({ formId: FID, version: 4 }) }));
  });

  it("STALE / NAME_TAKEN / NOT_FOUND; a body with neither definition nor active is 400", async () => {
    h.updateForm.mockResolvedValueOnce({ ok: false, reason: "stale" });
    expect(await json(await patch({ version: 1, active: true }))).toMatchObject({ error: { code: "STALE", message: "Someone else changed this form. Reload to see their changes." } });
    h.updateForm.mockResolvedValueOnce({ ok: false, reason: "name_taken" });
    expect((await json(await patch({ version: 1, active: true }))).error?.code).toBe("NAME_TAKEN");
    h.updateForm.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    expect((await patch({ version: 1, active: true })).status).toBe(404);
    expect((await patch({ version: 1 })).status).toBe(400);
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});
```

`src/app/api/admin/requests/[id]/forms/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ getAdminSession: vi.fn(), slidingWindow: vi.fn(), logAudit: vi.fn(), getRequestForms: vi.fn(), reopen: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/session", () => ({ getAdminSession: h.getAdminSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: h.slidingWindow }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/admin/form-queries", () => ({ getRequestForms: h.getRequestForms, reopenSubmission: h.reopen }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() }, errorCode: () => "x" }));

import { GET } from "./route";
import { POST as REOPEN } from "./[submissionId]/reopen/route";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
const reopen = (b: unknown, sid = SID) => REOPEN(new NextRequest(`http://localhost/api/admin/requests/${RID}/forms/${sid}/reopen`, { method: "POST", body: JSON.stringify(b) }), { params: Promise.resolve({ id: RID, submissionId: sid }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.getAdminSession.mockResolvedValue({ userId: U, organizationId: ORG, role: "admin" });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.logAudit.mockResolvedValue(undefined);
});

describe("GET /api/admin/requests/[id]/forms", () => {
  it("401 / 400 / 404 / 200", async () => {
    const get = (id = RID) => GET(new NextRequest("http://x"), { params: Promise.resolve({ id }) });
    h.getAdminSession.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    expect((await get("nope")).status).toBe(400);
    h.getRequestForms.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(404);
    h.getRequestForms.mockResolvedValueOnce({ submissions: [], missingRequired: [] });
    expect(await json(await get())).toEqual({ success: true, data: { submissions: [], missingRequired: [] } });
    expect(h.getRequestForms).toHaveBeenLastCalledWith(ORG, RID);
  });
});

describe("POST …/reopen (spec §5.5)", () => {
  it("changed → audit form_reopened with ids; already a draft → changed:false, no audit", async () => {
    h.reopen.mockResolvedValueOnce({ ok: true, revision: 5, changed: true, formId: "f", appointmentId: "a" });
    expect(await json(await reopen({ revision: 4 }))).toEqual({ success: true, data: { revision: 5, changed: true } });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "form_reopened", entityId: SID, details: JSON.stringify({ formId: "f", appointmentId: "a" }) }));
    h.reopen.mockResolvedValueOnce({ ok: true, revision: 5, changed: false, formId: "f", appointmentId: "a" });
    expect((await json(await reopen({ revision: 4 }))).data).toEqual({ revision: 5, changed: false });
    expect(h.logAudit).toHaveBeenCalledTimes(1);
  });

  it("STALE / ANSWERS_REMOVED / 404 / bad ids and bodies", async () => {
    h.reopen.mockResolvedValueOnce({ ok: false, reason: "stale" });
    expect(await json(await reopen({ revision: 1 }))).toMatchObject({ error: { code: "STALE", message: "Someone else changed this form. Reload to see the latest." } });
    h.reopen.mockResolvedValueOnce({ ok: false, reason: "answers_removed" });
    expect((await reopen({ revision: 1 })).status).toBe(409);
    h.reopen.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    expect((await reopen({ revision: 1 })).status).toBe(404);
    expect((await reopen({ revision: 1 }, "nope")).status).toBe(400);
    expect((await reopen({ revision: -1 })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/tech/form-route-guards.test.ts "src/app/api/tech/jobs/[id]/forms" "src/app/api/tech/jobs/[id]/site" src/app/api/admin/settings/forms "src/app/api/admin/requests/[id]/forms"`
Expected: FAIL — the route modules and `form-route-guards` are unresolved.

- [ ] **Step 3: Shared pieces.** Edits:

```diff
diff --git a/src/lib/rate-limit.ts b/src/lib/rate-limit.ts
index b2b0e8f..ed2ce55 100644
--- a/src/lib/rate-limit.ts
+++ b/src/lib/rate-limit.ts
@@ -92,6 +92,9 @@ export const RATE_LIMITS = {
   // a 30s timer. 60/min/user comfortably covers a few open tabs while still
   // capping a stuck/re-mounting client.
   adminRead: { maxRequests: 60, windowMs: 60_000 },
+  // M3d form draft autosave (PUT …/forms/[formId]/draft): a page sends at most
+  // ~20 a minute; 60 leaves room for two phones and retries.
+  techFormDraft: { maxRequests: 60, windowMs: 60_000 },
   // Webhook endpoints (Fieldpulse, Housecall Pro, etc.) — higher limit since
   // they're server-to-server and events can burst.
   webhook: { maxRequests: 200, windowMs: 60_000 },
```

```diff
diff --git a/src/lib/tech/invoice-route-guards.ts b/src/lib/tech/invoice-route-guards.ts
index 9a16910..981ad80 100644
--- a/src/lib/tech/invoice-route-guards.ts
+++ b/src/lib/tech/invoice-route-guards.ts
@@ -55,15 +55,16 @@ export function statusRefusal(
 const fail = (message: string, code: string, status: number) =>
   ({ ok: false as const, response: errorResponse(message, code, status) });
 
-/** session → same-origin → uuid → rate limit. */
-async function frontGates(
+/** session → same-origin → uuid → rate limit (`limit` defaults to the 30/min write limit; M3d draft autosave passes 60/min). */
+export async function frontGates(
   request: NextRequest, id: string, bucket: string,
+  limit: { readonly maxRequests: number; readonly windowMs: number } = RATE_LIMITS.adminMutation,
 ): Promise<{ ok: true; session: TechSessionPayload } | { ok: false; response: NextResponse }> {
   const session = await getTechSession();
   if (!session) return fail("Unauthorized", "UNAUTHORIZED", 401);
   if (!isSameOriginRequest(request)) return fail("Forbidden", "FORBIDDEN", 403);
   if (!isUuid(id)) return fail("Invalid request ID format", "INVALID_ID", 400);
-  const rate = slidingWindow(`tech:${bucket}:write:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
+  const rate = slidingWindow(`tech:${bucket}:write:${session.userId}`, limit.maxRequests, limit.windowMs);
   if (!rate.allowed) return fail("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
   return { ok: true, session };
 }
```

`src/lib/tech/form-route-guards.ts`:

```ts
/**
 * The technician form write preamble (M3d spec §6, `techFormPreamble`), in two
 * halves because the visit comes from the body: `techFormFront` (session,
 * same-origin, uuid on the job and the form, rate bucket `form` 30/min or
 * `form-draft` 60/min) runs before the body is read; `formGateFail` (readable
 * job, then the visit, assignment, on-site and erased-customer gates in one
 * read) after the replay checks — the draft route's saveId probe, the submit
 * route's idempotency key (lead ruling 3). The writers re-check everything
 * inside their batch.
 */
import type { NextRequest, NextResponse } from "next/server";
import type { TechSessionPayload } from "@/lib/auth/tech-config";
import { errorResponse } from "@/lib/api-response";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation/uuid";
import { readRows } from "@/lib/admin/invoice-field-writes";
import { findReadableJob } from "@/lib/tech/ownership";
import { gateReason, readFormGatesSql, toFormGates } from "@/lib/forms/form-gates";
import { frontGates } from "@/lib/tech/invoice-route-guards";
import { formReasonResponse } from "@/lib/tech/form-errors";
import type { FormWriteFail } from "@/lib/tech/form-writes";

type Front = { ok: true; session: TechSessionPayload } | { ok: false; response: NextResponse };

export async function techFormFront(request: NextRequest, id: string, formId: string, bucket: "form" | "form-draft"): Promise<Front> {
  const front = await frontGates(request, id, bucket, bucket === "form-draft" ? RATE_LIMITS.techFormDraft : RATE_LIMITS.adminMutation);
  if (!front.ok) return front;
  if (!isUuid(formId)) return { ok: false, response: errorResponse("Invalid form ID format", "INVALID_ID", 400) };
  return front;
}

/** The gates as a write refusal (null = pass). An unreadable job is NOT_FOUND. */
export async function formGateFail(
  session: TechSessionPayload, id: string, formId: string, rawAppointmentId: string,
): Promise<FormWriteFail | null> {
  const { organizationId: org, userId: me } = session;
  if (!(await findReadableJob(org, me, id))) return { ok: false, reason: "not_found" };
  const aid = rawAppointmentId.toLowerCase(); // Postgres returns lowercase uuids (resolveTarget's rule)
  const g = toFormGates((await readRows(readFormGatesSql(org, id, aid, me, formId.toLowerCase())))[0]);
  const reason = gateReason(g);
  return reason ? { ok: false, reason } : null;
}

export async function techFormGate(
  session: TechSessionPayload, id: string, formId: string, rawAppointmentId: string,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const fail = await formGateFail(session, id, formId, rawAppointmentId);
  if (!fail) return { ok: true };
  if (fail.reason === "not_found") return { ok: false, response: errorResponse("This job isn't yours.", "NOT_FOUND", 404) };
  return { ok: false, response: formReasonResponse(fail) };
}
```

`src/lib/forms/form-bodies.ts`:

```ts
/** Request bodies for the technician form writes (M3d spec §4.2–§4.3). */
import { z } from "zod";
import { FORM_LIMITS } from "./form-schema";

const changeValue = z.union([z.literal(true), z.string(), z.number(), z.null()]);

/** `{ [fieldId]: value | null }`; the writer checks keys and values against the snapshot. */
export const changesSchema = z
  .record(z.string(), changeValue)
  .refine((c) => Object.keys(c).length <= FORM_LIMITS.maxFields);

export const submitBodySchema = z.object({
  appointmentId: z.string().uuid(),
  formVersion: z.number().int().min(1),
  baseRevision: z.number().int().min(0),
  changes: changesSchema,
}).strict();

export const draftBodySchema = submitBodySchema.extend({ saveId: z.string().uuid() }).strict();

export type SubmitBody = z.infer<typeof submitBodySchema>;
export type DraftBody = z.infer<typeof draftBodySchema>;
```

`src/lib/tech/form-submit-hash.ts`:

```ts
/**
 * The submit route's idempotency hash input (M3d spec §4.3): the visit, the
 * versions and an HMAC of the canonical changes under its own label, so the
 * stored request hash holds no submitted string and can't be dictionary-
 * attacked back to answers after an erase. Server-only (node:crypto).
 */
import { macHex } from "@/lib/crypto";
import { canonicalJson } from "@/lib/http/idempotency";
import type { SubmitBody } from "@/lib/forms/form-bodies";

export const FORM_CHANGES_LABEL = "hvac-form-changes-v1";

export function submitHashInput(b: SubmitBody): Record<string, unknown> {
  return {
    appointmentId: b.appointmentId.toLowerCase(),
    formVersion: b.formVersion,
    baseRevision: b.baseRevision,
    changesMac: macHex(FORM_CHANGES_LABEL, canonicalJson(b.changes)),
  };
}
```

`src/lib/admin/form-route-copy.ts`:

```ts
/** Office form route bodies and refusal copy (M3d spec §4.1, §5.6, §8). */
import { z } from "zod";
import { formDefinitionSchema } from "@/lib/forms/form-schema";

export const createFormBodySchema = formDefinitionSchema.extend({ clientToken: z.string().uuid() }).strict();

/** PATCH: a whole definition (fields replaced whole) or an archive / restore, always with the CAS version. */
export const patchFormBodySchema = z.object({
  version: z.number().int().min(1),
  definition: formDefinitionSchema.optional(),
  active: z.boolean().optional(),
}).strict().refine((b) => b.definition !== undefined || b.active !== undefined);

export const reopenBodySchema = z.object({ revision: z.number().int().min(0) }).strict();

export const FORM_OFFICE_COPY = {
  NAME_TAKEN: "A form with this name already exists.",
  STALE: "Someone else changed this form. Reload to see their changes.",
  LIMIT_REACHED: "You've reached the limit of 100 forms.",
  UNKNOWN_JOB_TYPE: "One of those job types no longer exists.",
  NOT_FOUND: "Form not found.",
  REOPEN_STALE: "Someone else changed this form. Reload to see the latest.",
  ANSWERS_REMOVED: "These answers were removed.",
} as const;
```

- [ ] **Step 4: Technician routes.** `src/app/api/tech/jobs/[id]/forms/route.ts`:

```ts
/**
 * GET /api/tech/jobs/[id]/forms?visit=<aid> — the visit's forms for the job
 * page card (M3d spec §6). Any technician who can read the job; the visit must
 * belong to the request and count (spec §5.1), else 404.
 */
import type { NextRequest } from "next/server";
import { getTechSession } from "@/lib/auth/tech-session";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse, successResponse } from "@/lib/api-response";
import { errorCode, logger } from "@/lib/logger";
import { getJobForms } from "@/lib/tech/form-reads";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const { id } = await params;
    const visit = request.nextUrl.searchParams.get("visit");
    if (!isUuid(id) || !isUuid(visit)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const rate = slidingWindow(`tech:form:read:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
    const r = await getJobForms(session.organizationId, session.userId, id, visit);
    if (r.kind === "not_found") return errorResponse("This job isn't yours.", "NOT_FOUND", 404);
    return successResponse(r.view);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load job forms");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}
```

`src/app/api/tech/jobs/[id]/forms/[formId]/route.ts`:

```ts
/**
 * GET /api/tech/jobs/[id]/forms/[formId]?visit=<aid> — one form for the fill
 * page (M3d spec §6): the row's snapshot when it exists, else the live form;
 * an archived form with no row → 409 FORM_ARCHIVED; a foreign form id → 404.
 */
import type { NextRequest } from "next/server";
import { getTechSession } from "@/lib/auth/tech-session";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse, successResponse } from "@/lib/api-response";
import { errorCode, logger } from "@/lib/logger";
import { getJobForm } from "@/lib/tech/form-reads";
import { FORM_REASON } from "@/lib/tech/form-errors";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; formId: string }> }) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const { id, formId } = await params;
    const visit = request.nextUrl.searchParams.get("visit");
    if (!isUuid(id) || !isUuid(formId) || !isUuid(visit)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const rate = slidingWindow(`tech:form:read:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
    const r = await getJobForm(session.organizationId, session.userId, id, formId, visit);
    if (r.kind === "not_found") return errorResponse(FORM_REASON.not_found.message, "NOT_FOUND", 404);
    if (r.kind === "archived") return errorResponse(FORM_REASON.form_archived.message, "FORM_ARCHIVED", 409);
    return successResponse(r.view);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load job form");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}
```

`src/app/api/tech/jobs/[id]/forms/[formId]/draft/route.ts`:

```ts
/**
 * PUT /api/tech/jobs/[id]/forms/[formId]/draft — autosave (M3d spec §4.2,
 * §5.2). No idempotency key: the body's `saveId` makes a retry a replay — checked
 * FIRST, before the gates, so a retry of a landed write answers 200 even after
 * the visit ended — and the revision gate refuses anything else as STALE. 201
 * on the first write (the row was created), 200 after. No audit.
 */
import type { NextRequest } from "next/server";
import { errorResponse, successResponse } from "@/lib/api-response";
import { errorCode, logger } from "@/lib/logger";
import { readWriteBody } from "@/lib/tech/invoice-write-route";
import { techFormFront, techFormGate } from "@/lib/tech/form-route-guards";
import { draftBodySchema } from "@/lib/forms/form-bodies";
import { findDraftReplay, saveFormDraft } from "@/lib/tech/form-writes";
import { formReasonResponse } from "@/lib/tech/form-errors";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; formId: string }> }) {
  try {
    const { id, formId } = await params;
    const front = await techFormFront(request, id, formId, "form-draft");
    if (!front.ok) return front.response;
    const body = await readWriteBody(request, draftBodySchema);
    if (!body.ok) return body.response;
    const { organizationId, userId } = front.session;
    const actor = { organizationId, requestId: id.toLowerCase(), techUserId: userId };
    const replay = await findDraftReplay(actor, { ...body.data, formId });
    if (replay?.ok) return successResponse({ submissionId: replay.submissionId, revision: replay.revision, savedAt: replay.savedAt }, 200);
    const gate = await techFormGate(front.session, id, formId, body.data.appointmentId);
    if (!gate.ok) return gate.response;
    const r = await saveFormDraft(actor, { ...body.data, formId });
    if (!r.ok) return formReasonResponse(r);
    return successResponse({ submissionId: r.submissionId, revision: r.revision, savedAt: r.savedAt }, r.created ? 201 : 200);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to save form draft");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}
```

`src/app/api/tech/jobs/[id]/forms/[formId]/submit/route.ts`:

```ts
/**
 * POST /api/tech/jobs/[id]/forms/[formId]/submit — keyed submit (M3d spec
 * §4.3, §5.3). The request hash covers the visit, versions and an HMAC of the
 * canonical changes (labelled "hvac-form-changes-v1"), never the answers
 * themselves; `submit_key` = derivedId(scope, "form-submit"). The gates run
 * INSIDE the keyed run, so a retry of a submit that landed replays even after
 * the job closed (their codes are unstored: a refusal releases the key). The
 * audit row is written inside the writer's batch.
 */
import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api-response";
import { errorCode, logger } from "@/lib/logger";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { formGateFail, techFormFront } from "@/lib/tech/form-route-guards";
import { submitBodySchema } from "@/lib/forms/form-bodies";
import { submitHashInput } from "@/lib/tech/form-submit-hash";
import { submitForm } from "@/lib/tech/form-writes";
import { formReasonResult } from "@/lib/tech/form-errors";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; formId: string }> }) {
  try {
    const { id, formId } = await params;
    const front = await techFormFront(request, id, formId, "form");
    if (!front.ok) return front.response;
    const body = await readWriteBody(request, submitBodySchema);
    if (!body.ok) return body.response;
    const key = readKey(request);
    if (!key.ok) return key.response;
    const { organizationId, userId } = front.session;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(submitHashInput(body.data)),
      async (ids) => {
        const gate = await formGateFail(front.session, id, formId, body.data.appointmentId);
        if (gate) return formReasonResult(gate);
        const r = await submitForm(
          { organizationId, requestId: id.toLowerCase(), techUserId: userId },
          { ...body.data, formId },
          { submitKey: ids.id("form-submit") },
        );
        if (!r.ok) return formReasonResult(r);
        return okResult(200, { submissionId: r.submissionId, revision: r.revision, submittedAt: r.submittedAt });
      },
    );
    return toResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to submit form");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

`src/app/api/tech/jobs/[id]/site/route.ts`:

```ts
/** GET /api/tech/jobs/[id]/site — what the technician should know about this address (M3d spec §7.6). */
import type { NextRequest } from "next/server";
import { getTechSession } from "@/lib/auth/tech-session";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse, successResponse } from "@/lib/api-response";
import { errorCode, logger } from "@/lib/logger";
import { getSiteView } from "@/lib/tech/site-queries";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const rate = slidingWindow(`tech:site:read:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
    const r = await getSiteView(session.organizationId, session.userId, id);
    if (r.kind === "not_found") return errorResponse("This job isn't yours.", "NOT_FOUND", 404);
    return successResponse(r.view);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load the site view");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}
```

- [ ] **Step 5: Office routes.** `src/app/api/admin/settings/forms/route.ts`:

```ts
/**
 * GET /api/admin/settings/forms — the Forms tab list.
 * POST — first valid Save of a new form (M3d spec §4.1): id =
 * officeId("form", org, clientToken); 201 created, 200 replay; audit
 * `form_created` only when created.
 */
import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { errorResponse, readJsonBody, successResponse } from "@/lib/api-response";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";
import { logAudit } from "@/lib/admin/audit";
import { createForm, listForms } from "@/lib/admin/form-queries";
import { createFormBodySchema, FORM_OFFICE_COPY } from "@/lib/admin/form-route-copy";
import { firstIssuePath } from "@/lib/forms/form-schema";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:forms-list:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    return successResponse({ forms: await listForms(session.organizationId) });
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to list forms");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:forms-create:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const parsed = createFormBodySchema.safeParse(body.data);
    if (!parsed.success) return errorResponse("Invalid form", "VALIDATION_ERROR", 400, { path: firstIssuePath(parsed.error) });
    const { clientToken, ...def } = parsed.data;

    const r = await createForm(session.organizationId, session.userId, clientToken, def);
    if (!r.ok) {
      if (r.reason === "name_taken") return errorResponse(FORM_OFFICE_COPY.NAME_TAKEN, "NAME_TAKEN", 409);
      if (r.reason === "limit_reached") return errorResponse(FORM_OFFICE_COPY.LIMIT_REACHED, "LIMIT_REACHED", 409);
      return errorResponse(FORM_OFFICE_COPY.UNKNOWN_JOB_TYPE, "UNKNOWN_JOB_TYPE", 400);
    }
    if (r.created) {
      await logAudit({
        organizationId: session.organizationId, userId: session.userId, action: "form_created", entity: "forms", entityId: r.id,
        details: JSON.stringify({ formId: r.id }),
      }).catch((e: unknown) => logger.error({ code: errorCode(e) }, "Failed to audit form creation"));
    }
    return successResponse({ id: r.id }, r.created ? 201 : 200);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to create form");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

`src/app/api/admin/settings/forms/[id]/route.ts`:

```ts
/**
 * GET /api/admin/settings/forms/[id] — `{ form, submissionCount }`, org-scoped
 * (a foreign id is 404). PATCH — `{ version, definition }` (fields replaced
 * whole) or `{ version, active }` (archive / restore) under a version CAS
 * (M3d spec §4.1, §5.6). Audits `form_updated` / `form_archived` /
 * `form_restored`, ids and enums only.
 */
import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { errorResponse, readJsonBody, successResponse } from "@/lib/api-response";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";
import { logAudit } from "@/lib/admin/audit";
import { getForm, updateForm } from "@/lib/admin/form-queries";
import { FORM_OFFICE_COPY, patchFormBodySchema } from "@/lib/admin/form-route-copy";
import { firstIssuePath } from "@/lib/forms/form-schema";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:forms-read:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid form ID format", "INVALID_ID", 400);
    const r = await getForm(session.organizationId, id);
    if (!r) return errorResponse(FORM_OFFICE_COPY.NOT_FOUND, "NOT_FOUND", 404);
    return successResponse(r);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load form");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:forms-update:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid form ID format", "INVALID_ID", 400);
    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const parsed = patchFormBodySchema.safeParse(body.data);
    if (!parsed.success) return errorResponse("Invalid form", "VALIDATION_ERROR", 400, { path: firstIssuePath(parsed.error) });

    const r = await updateForm(session.organizationId, id, parsed.data);
    if (!r.ok) {
      if (r.reason === "not_found") return errorResponse(FORM_OFFICE_COPY.NOT_FOUND, "NOT_FOUND", 404);
      if (r.reason === "stale") return errorResponse(FORM_OFFICE_COPY.STALE, "STALE", 409);
      if (r.reason === "name_taken") return errorResponse(FORM_OFFICE_COPY.NAME_TAKEN, "NAME_TAKEN", 409);
      return errorResponse(FORM_OFFICE_COPY.UNKNOWN_JOB_TYPE, "UNKNOWN_JOB_TYPE", 400);
    }
    const d = parsed.data;
    const audits: { action: string; details: Record<string, unknown> }[] = [];
    if (d.definition) audits.push({ action: "form_updated", details: { formId: id, version: r.version, fieldCount: d.definition.fields.length } });
    if (d.active === false) audits.push({ action: "form_archived", details: { formId: id, version: r.version } });
    if (d.active === true) audits.push({ action: "form_restored", details: { formId: id, version: r.version } });
    for (const a of audits) {
      await logAudit({
        organizationId: session.organizationId, userId: session.userId, action: a.action, entity: "forms", entityId: id,
        details: JSON.stringify(a.details),
      }).catch((e: unknown) => logger.error({ code: errorCode(e) }, "Failed to audit form update"));
    }
    return successResponse({ version: r.version });
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to update form");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

`src/app/api/admin/requests/[id]/forms/route.ts`:

```ts
/**
 * GET /api/admin/requests/[id]/forms — the request's submissions and the
 * required forms not submitted yet (M3d spec §6). Undecryptable answers read
 * `unreadable`, never a 500.
 */
import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { errorResponse, successResponse } from "@/lib/api-response";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";
import { getRequestForms } from "@/lib/admin/form-queries";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:request-forms:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const r = await getRequestForms(session.organizationId, id);
    if (!r) return errorResponse("Request not found", "NOT_FOUND", 404);
    return successResponse(r);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load request forms");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

`src/app/api/admin/requests/[id]/forms/[submissionId]/reopen/route.ts`:

```ts
/**
 * POST /api/admin/requests/[id]/forms/[submissionId]/reopen `{ revision }` —
 * the office reopens a submitted form (M3d spec §5.5). Already a draft → 200
 * `{ changed: false }`; erased → 409 ANSWERS_REMOVED; moved on → 409 STALE.
 * Audit `form_reopened` only when it changed. Nobody is notified.
 */
import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { errorResponse, readJsonBody, successResponse } from "@/lib/api-response";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";
import { logAudit } from "@/lib/admin/audit";
import { reopenSubmission } from "@/lib/admin/form-queries";
import { FORM_OFFICE_COPY, reopenBodySchema } from "@/lib/admin/form-route-copy";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; submissionId: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:forms-reopen:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const { id, submissionId } = await params;
    if (!isUuid(id) || !isUuid(submissionId)) return errorResponse("Invalid ID format", "INVALID_ID", 400);
    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const parsed = reopenBodySchema.safeParse(body.data);
    if (!parsed.success) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);

    const r = await reopenSubmission(session.organizationId, id, submissionId, parsed.data.revision);
    if (!r.ok) {
      if (r.reason === "not_found") return errorResponse("Form not found", "NOT_FOUND", 404);
      if (r.reason === "answers_removed") return errorResponse(FORM_OFFICE_COPY.ANSWERS_REMOVED, "ANSWERS_REMOVED", 409);
      return errorResponse(FORM_OFFICE_COPY.REOPEN_STALE, "STALE", 409);
    }
    if (r.changed) {
      await logAudit({
        organizationId: session.organizationId, userId: session.userId, action: "form_reopened", entity: "form_submissions",
        entityId: submissionId, details: JSON.stringify({ formId: r.formId, appointmentId: r.appointmentId }),
      }).catch((e: unknown) => logger.error({ code: errorCode(e) }, "Failed to audit form reopen"));
    }
    return successResponse({ revision: r.revision, changed: r.changed });
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to reopen form");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

- [ ] **Step 6: Run them to verify they pass**

Run: the Step 2 command, then `npx vitest run src/lib/tech/invoice-route-guards.test.ts` (unchanged: its 429 case still sees the 30/min write limit).
Expected: PASS (form-route-guards 6, tech forms routes 10, site 2, settings forms 7, request forms 3).

- [ ] **Step 7: The walk fixture** — `scripts/agent/m3d-walk.mts` (seeds the spec §9 walk data on a throwaway org; prints ids and minted sessions; `delete <org>` checks the org queued nothing, then deletes it):

```ts
/**
 * M3d browser-walk fixture (dev only). Creates a THROWAWAY org with
 * createOrgCore and seeds the spec §9 walk data by SQL; prints JSON with the
 * ids and minted session tokens (each token's org asserted). Never touches the
 * default org; refuses prod; refuses to seed while the comms queue holds a
 * due message. `delete <orgId>` asserts the org queued nothing, then deletes it.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/m3d-walk.mts seed
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/m3d-walk.mts delete <orgId>
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
}
if ((process.env.DATABASE_URL ?? "").includes("ep-withered-hill")) throw new Error("Refusing to run against the production database");

const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
const { db } = await import("../../src/lib/db");
const { sql } = await import("drizzle-orm");
const { encrypt } = await import("../../src/lib/crypto");
const { signToken } = await import("../../src/lib/auth/config");
const { signTechToken } = await import("../../src/lib/auth/tech-config");
const { createOrgCore } = await import("../../src/lib/admin/provisioning");

type Row = Record<string, unknown>;
const run = async (q: ReturnType<typeof sql>): Promise<Row[]> => (await db.execute(q)).rows as Row[];
const one = async (q: ReturnType<typeof sql>): Promise<string> => String((await run(q))[0]!.id);

async function queueGuard(): Promise<void> {
  const [r] = await run(sql`SELECT count(*)::int AS n FROM communication_jobs WHERE status = 'pending' AND scheduled_for <= now() + interval '15 minutes'`);
  if (Number(r!.n) !== 0) throw new Error(`comms queue holds ${String(r!.n)} due message(s); not walking`);
}

async function seed(): Promise<void> {
  await queueGuard();
  const out = await createOrgCore({
    name: `Probe Org M3d Walk ${randomUUID().slice(0, 8)}`,
    createdBy: null,
    ownerEmail: null,
    ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
    skipOrgCountCheck: true,
  });
  if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
  const org = out.result.organizationId;
  if (org === DEFAULT_ORG) throw new Error("refusing the default org");
  const admin = out.result.ownerUserId!;
  const tech = (name: string) => one(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
    VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example',${name},'technician','x',true) RETURNING id`);
  const lead = await tech("Alex Rivera");
  const helper = await tech("Sam Lee");
  const jobType = String((await run(sql`SELECT id FROM job_types WHERE organization_id = ${org} ORDER BY position LIMIT 1`))[0]!.id);

  const ADDR_A = "12 Elm St, Johnson City, TN 37601";
  const custA = await one(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},${encrypt("Pat Probe")}) RETURNING id`);
  const custB = await one(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},${encrypt("Robin Other")}) RETURNING id`);
  const loc = await one(sql`INSERT INTO customer_locations (organization_id,customer_id,address_encrypted,label,is_primary)
    VALUES (${org},${custA},${encrypt(ADDR_A)},'Main house',true) RETURNING id`);
  const request = async (o: { cust: string; status: string; address: string | null; locationId: string | null; jobTypeId?: string | null; fieldpulse?: boolean; daysAgo?: number }) => {
    const sess = await one(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`);
    const when = new Date(Date.now() - (o.daysAgo ?? 0) * 86_400_000).toISOString();
    return one(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,customer_id,location_id,job_type_id,issue_type,urgency,description,reference_number,scheduled_date,status,completed_at,address_encrypted,fieldpulse_job_id)
      VALUES (${org},${sess},${lead},${o.cust},${o.locationId},${o.jobTypeId ?? null},'no_heat','medium','Walk probe','WLK-'||substr(md5(random()::text),1,8),${when}::timestamptz,
        ${o.status}::request_status,${o.status === "completed" ? when : null}::timestamptz,${o.address ? encrypt(o.address) : null},${o.fieldpulse ? `fp-walk-${randomUUID().slice(0, 8)}` : null})
      RETURNING id`);
  };
  const past1 = await request({ cust: custA, status: "completed", address: ADDR_A, locationId: loc, daysAgo: 40 });
  const past2 = await request({ cust: custA, status: "completed", address: ADDR_A, locationId: loc, daysAgo: 10 });
  const est = await one(sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents,expires_at)
    VALUES (${org},${past2},${custA},'open',481200,now() + interval '20 days') RETURNING id`);
  await run(sql`INSERT INTO estimate_options (organization_id,estimate_id,name,sort_order,subtotal_cents,tax_cents,total_cents)
    VALUES (${org},${est},'Good',0,295000,0,295000),(${org},${est},'Better',1,481200,0,481200)`);
  const plan = await one(sql`INSERT INTO membership_plans (organization_id,name,price_cents,visits_per_year) VALUES (${org},'Comfort Club',1500,2) RETURNING id`);
  const mem = await one(sql`INSERT INTO customer_memberships (organization_id,customer_id,plan_id,status,current_period_end)
    VALUES (${org},${custA},${plan},'active',now() + interval '150 days') RETURNING id`);
  await run(sql`INSERT INTO membership_visits (organization_id,customer_membership_id,due_date,period_key,status)
    VALUES (${org},${mem},now() + interval '60 days','walk-1','scheduled')`);
  const job = await request({ cust: custA, status: "in_progress", address: ADDR_A, locationId: loc, jobTypeId: jobType });
  const visit = String((await run(sql`SELECT id FROM appointments WHERE service_request_id = ${job} AND appointment_number = 1`))[0]!.id);
  await run(sql`UPDATE appointment_assignments SET status = 'in_progress'::request_status, en_route_at = now(), arrived_at = now(), started_at = now()
    WHERE appointment_id = ${visit} AND technician_id = ${lead} AND organization_id = ${org}`);
  await run(sql`INSERT INTO appointment_assignments (organization_id,appointment_id,technician_id,is_lead,status,arrived_at,started_at)
    VALUES (${org},${visit},${helper},false,'in_progress'::request_status,now(),now())`);
  const otherJob = await request({ cust: custB, status: "completed", address: "40 Oak Ave, Bristol, TN 37620", locationId: null, daysAgo: 5 });
  // Customer B's: an address-less sibling of A's would make A's membership `withheld` (spec §7.6).
  const synced = await request({ cust: custB, status: "scheduled", address: null, locationId: null, fieldpulse: true });

  const users = await run(sql`SELECT id, email, name, role, organization_id FROM users WHERE id IN (${admin}, ${lead}, ${helper})`);
  const user = (id: string) => users.find((u) => u.id === id)!;
  const tokens = {
    admin: await signToken({ userId: admin, email: String(user(admin).email), name: String(user(admin).name), role: user(admin).role as "super_admin", organizationId: org }),
    lead: await signTechToken({ userId: lead, email: String(user(lead).email), name: "Alex Rivera", role: "technician", organizationId: org }),
    helper: await signTechToken({ userId: helper, email: String(user(helper).email), name: "Sam Lee", role: "technician", organizationId: org }),
  };
  for (const u of users) if (u.organization_id !== org) throw new Error("token org mismatch");
  console.log(JSON.stringify({ org, admin, lead, helper, jobType, custA, custB, loc, past1, past2, job, visit, otherJob, synced, tokens }));
}

async function remove(org: string): Promise<void> {
  if (org === DEFAULT_ORG) throw new Error("refusing the default org");
  const [q] = await run(sql`SELECT count(*)::int AS n FROM communication_jobs WHERE organization_id = ${org}`);
  if (Number(q!.n) !== 0) throw new Error(`the walk queued ${String(q!.n)} communication job(s)`);
  await run(sql`DELETE FROM organizations WHERE id = ${org} AND name LIKE 'Probe Org M3d Walk %'`);
  console.log(JSON.stringify({ deleted: org }));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "seed") await seed();
else if (cmd === "delete" && arg) await remove(arg);
else throw new Error("usage: m3d-walk.mts seed | delete <orgId>");
process.exit(0);
```

- [ ] **Step 8: Probe on a throwaway org.** Dev server running (`npm run dev`). `probe-m3d-8.mts` at the repo root:

```ts
import { execFileSync } from "node:child_process";
const env = { ...process.env, NODE_OPTIONS: "--conditions=react-server" };
const fx = JSON.parse(execFileSync("npx", ["tsx", "scripts/agent/m3d-walk.mts", "seed"], { encoding: "utf8", env }).trim().split("\n").pop()!);
const BASE = "http://localhost:3000";
const admin = { "content-type": "application/json", cookie: `hvac_admin_session=${fx.tokens.admin}`, origin: BASE };
const tech = { "content-type": "application/json", cookie: `hvac_tech_session=${fx.tokens.lead}`, origin: BASE };
const log = (k: string, v: unknown) => console.log(k, JSON.stringify(v));
try {
  const token = crypto.randomUUID();
  const body = { clientToken: token, name: "Probe checklist", description: null, jobTypeIds: [], required: true,
    fields: [{ id: "f_probe00001", type: "checkbox", label: "Filter changed", required: true }] };
  const c1 = await fetch(`${BASE}/api/admin/settings/forms`, { method: "POST", headers: admin, body: JSON.stringify(body) });
  const c2 = await fetch(`${BASE}/api/admin/settings/forms`, { method: "POST", headers: admin, body: JSON.stringify(body) });
  const formId = (await c1.json()).data.id;
  log("create", [c1.status, c2.status]); // [201, 200]
  const list = await (await fetch(`${BASE}/api/tech/jobs/${fx.job}/forms?visit=${fx.visit}`, { headers: tech })).json();
  log("card", list.data.forms.map((f: { name: string }) => f.name)); // ["Probe checklist"]
  const saveId = crypto.randomUUID();
  const put = (b: object) => fetch(`${BASE}/api/tech/jobs/${fx.job}/forms/${formId}/draft`, { method: "PUT", headers: tech, body: JSON.stringify(b) });
  const d = { appointmentId: fx.visit, formVersion: 1, baseRevision: 0, saveId, changes: { f_probe00001: true } };
  log("draft", [(await put(d)).status, (await put(d)).status, (await put({ ...d, saveId: crypto.randomUUID() })).status]); // [201, 200, 409]
  const sub = (key: string) => fetch(`${BASE}/api/tech/jobs/${fx.job}/forms/${formId}/submit`, {
    method: "POST", headers: { ...tech, "idempotency-key": key }, body: JSON.stringify({ appointmentId: fx.visit, formVersion: 1, baseRevision: 1, changes: {} }) });
  const k = crypto.randomUUID();
  log("submit", [(await sub(k)).status, (await sub(k)).status, (await (await sub(crypto.randomUUID())).json()).error.code]); // [200, 200, "FORM_SUBMITTED"]
  const office = await (await fetch(`${BASE}/api/admin/requests/${fx.job}/forms`, { headers: admin })).json();
  log("office", office.data.submissions.map((s: { status: string }) => s.status)); // ["submitted"]
  const site = await (await fetch(`${BASE}/api/tech/jobs/${fx.job}/site`, { headers: tech })).json();
  log("site", [site.data.scope, site.data.pastJobs.length, site.data.membership.state]); // ["location", 2, "member"]
} finally {
  execFileSync("npx", ["tsx", "scripts/agent/m3d-walk.mts", "delete", fx.org], { encoding: "utf8", env, stdio: "inherit" });
}
```

Run `npx tsx probe-m3d-8.mts`. Expected: the commented values, and the fixture's `delete` line prints `{"deleted":"<org>"}`. Delete the probe.

- [ ] **Step 9: Gates and commit**

```bash
npx tsc --noEmit && npx eslint scripts/agent/m3d-walk.mts src/lib/rate-limit.ts src/lib/tech/invoice-route-guards.ts src/lib/tech/form-route-guards.ts src/lib/tech/form-route-guards.test.ts src/lib/forms/form-bodies.ts src/lib/tech/form-submit-hash.ts src/lib/admin/form-route-copy.ts "src/app/api/tech/jobs/[id]/forms" "src/app/api/tech/jobs/[id]/site" src/app/api/admin/settings/forms "src/app/api/admin/requests/[id]/forms" && npx vitest run
git add scripts/agent/m3d-walk.mts src/lib/rate-limit.ts src/lib/tech/invoice-route-guards.ts src/lib/tech/form-route-guards.ts src/lib/tech/form-route-guards.test.ts src/lib/forms/form-bodies.ts src/lib/tech/form-submit-hash.ts src/lib/admin/form-route-copy.ts "src/app/api/tech/jobs/[id]/forms" "src/app/api/tech/jobs/[id]/site" src/app/api/admin/settings/forms "src/app/api/admin/requests/[id]/forms"
git commit -m "$(cat <<'EOF'
feat(m3d): form routes (tech GETs, draft PUT, keyed submit, site) and office settings/request routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---
### Task 9: Office builder — Settings → Forms tab and the form builder page

**Files:**
- Create: `src/lib/admin/form-builder.ts`, `src/lib/admin/form-builder.test.ts`, `src/lib/admin/forms-tab.ts`, `src/lib/admin/forms-tab.test.ts`, `src/components/admin/settings/forms-panel.tsx`, `src/components/admin/forms/form-field-editor.tsx`, `src/components/admin/forms/form-builder-client.tsx`, `src/app/admin/(dashboard)/settings/forms/[id]/page.tsx`
- Modify: `src/lib/admin/settings-tabs.ts` (`forms` after `job-types`), `src/lib/admin/settings-tabs.test.ts`, `src/app/admin/(dashboard)/settings/page.tsx` (one tab trigger + one panel; re-read it right before editing)

**Interfaces:**
- Consumes: Task 2 `FORM_LIMITS`, `FIELD_TYPES`, `utf8Bytes`, `numberInputState`, `FormDefinition`, `FormField`; Task 5 `FormRecord`, `FormListRow` (types only); Task 8 `FORM_OFFICE_COPY` and the office routes; `mintKey` (`src/lib/http/idempotency-codes.ts`); `useUnsavedChangesGuard` (`src/hooks/use-unsaved-changes-guard.ts`, holds in-app links; the builder renders the confirm like `settings/page.tsx`); `LEAVE_UNSAVED_TITLE` / `LEAVE_UNSAVED_COPY` (`src/lib/admin/unsaved-changes.ts`); admin-ui `PageShell`, `PageHeader`, `SectionCard`, `EmptyState`, `LoadErrorState`, `ConfirmDialog`; `JobTypeRecord` (`src/lib/admin/job-type-types.ts`).
- Produces: `BuilderField`, `BuilderForm`, `TYPE_LABELS`, `UNIT_SUGGESTIONS`, `newFieldId`, `newOptionId`, `blankField`, `newBuilderForm`, `addField`, `moveField`, `removeField`, `restoreField`, `changeType`, `toFormFields`, `toDefinition`, `fromDefinition`, `sameDefinition`, `BUILDER_COPY`, `builderErrors`, `visibleErrors`, `firstSaveOutcome`, `afterReplay`; `formsTabAppliesTo`, `formatChangedAt`; `SETTINGS_TABS` includes `'forms'`.

- [ ] **Step 1: Write the failing tests** — `src/lib/admin/form-builder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  addField, afterReplay, blankField, BUILDER_COPY, builderErrors, changeType, firstSaveOutcome, fromDefinition, moveField, newBuilderForm,
  newFieldId, newOptionId, removeField, restoreField, toDefinition, visibleErrors, type BuilderField, type BuilderForm,
} from "./form-builder";
import { formDefinitionSchema } from "@/lib/forms/form-schema";

let seed = 0;
const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
const field = (over: Partial<BuilderField> = {}): BuilderField => ({ ...blankField("checkbox", rnd), label: "Filter changed", ...over });
const form = (over: Partial<BuilderForm> = {}): BuilderForm => ({ ...newBuilderForm(rnd), name: "Maintenance checklist", fields: [field()], ...over });
const messages = (f: BuilderForm) => builderErrors(f).map((e) => e.message);

describe("ids", () => {
  it("fields f_ + 10, options o_ + 8, lowercase alphanumerics", () => {
    expect(newFieldId(rnd)).toMatch(/^f_[a-z0-9]{10}$/);
    expect(newOptionId(rnd)).toMatch(/^o_[a-z0-9]{8}$/);
  });
});

describe("list helpers (spec §7.1)", () => {
  it("new form = empty name and one blank Checkbox", () => {
    const f = newBuilderForm(rnd);
    expect(f.name).toBe("");
    expect(f.fields.map((x) => [x.type, x.label])).toEqual([["checkbox", ""]]);
  });
  it("add below, move up / down, remove then undo restores the position", () => {
    const a = field({ label: "A" });
    const b = field({ label: "B" });
    const added = addField([a, b], 0, rnd);
    expect(added.map((x) => x.label)).toEqual(["A", "", "B"]);
    expect(moveField([a, b], 1, -1).map((x) => x.label)).toEqual(["B", "A"]);
    expect(moveField([a, b], 0, -1).map((x) => x.label)).toEqual(["A", "B"]);
    const r = removeField([a, b], 0);
    expect(r.fields.map((x) => x.label)).toEqual(["B"]);
    expect(restoreField(r.fields, r.removed!).map((x) => x.label)).toEqual(["A", "B"]);
  });
  it("changeType keeps label and help, forces heading's required off, drops extras, seeds two choice options", () => {
    const n = field({ type: "number", required: true, help: "h", unit: "psi", usualMin: "5" });
    expect(changeType(n, "heading", rnd)).toMatchObject({ type: "heading", label: "Filter changed", help: "h", required: false, unit: "", usualMin: "" });
    expect(changeType(n, "yes_no", rnd)).toMatchObject({ required: true, allowNa: false });
    const c = changeType(n, "choice", rnd);
    expect(c.options).toHaveLength(2);
    expect(c.options.every((o) => o.label === "")).toBe(true);
  });
});

describe("builderErrors (spec §8): one message per rule", () => {
  it("a valid form has none and converts to a schema-valid definition", () => {
    const f = form();
    expect(builderErrors(f)).toEqual([]);
    expect(formDefinitionSchema.safeParse(toDefinition(f)).success).toBe(true);
  });
  it("header rules", () => {
    expect(messages(form({ name: "  " }))).toContain(BUILDER_COPY.name);
    expect(messages(form({ name: "x".repeat(81) }))).toContain(BUILDER_COPY.nameLong);
    expect(messages(form({ description: "x".repeat(301) }))).toContain(BUILDER_COPY.descriptionLong);
    expect(messages(form({ appliesTo: "some", jobTypeIds: [] }))).toContain(BUILDER_COPY.jobTypes);
    expect(messages(form({ fields: [field({ type: "heading" })] }))).toContain(BUILDER_COPY.noQuestion);
    expect(messages(form({ fields: Array.from({ length: 61 }, () => field()) }))).toContain(BUILDER_COPY.tooMany);
    expect(messages(form({ fields: Array.from({ length: 11 }, () => field({ type: "long_text" })) }))).toContain(BUILDER_COPY.longText);
  });
  it("field rules", () => {
    expect(messages(form({ fields: [field({ label: "" })] }))).toContain(BUILDER_COPY.label);
    expect(messages(form({ fields: [field({ label: "x".repeat(121) })] }))).toContain(BUILDER_COPY.labelLong);
    expect(messages(form({ fields: [field({ help: "x".repeat(201) })] }))).toContain(BUILDER_COPY.helpLong);
    expect(messages(form({ fields: [field({ type: "number", unit: "x".repeat(13) })] }))).toContain(BUILDER_COPY.unitLong);
    expect(messages(form({ fields: [field({ type: "number", usualMin: "15", usualMax: "5" })] }))).toContain(BUILDER_COPY.range);
    expect(messages(form({ fields: [field({ type: "number", usualMin: "1e3" })] }))).toContain(BUILDER_COPY.rangeNumber);
    const opts = (labels: string[]) => labels.map((label) => ({ id: newOptionId(rnd), label }));
    expect(messages(form({ fields: [field({ type: "choice", options: opts(["A"]) })] }))).toContain(BUILDER_COPY.fewOptions);
    expect(messages(form({ fields: [field({ type: "choice", options: opts(Array.from({ length: 13 }, (_, i) => `O${i}`)) })] }))).toContain(BUILDER_COPY.manyOptions);
    expect(messages(form({ fields: [field({ type: "choice", options: opts(["A", ""]) })] }))).toContain(BUILDER_COPY.optionLabel);
    expect(messages(form({ fields: [field({ type: "choice", options: opts(["A", "x".repeat(61)]) })] }))).toContain(BUILDER_COPY.optionLong);
    expect(messages(form({ fields: [field({ type: "choice", options: opts(["Clean", "clean"]) })] }))).toContain(BUILDER_COPY.optionDuplicate);
  });
  it("the 64 KB size rule", () => {
    const options = Array.from({ length: 12 }, (_, j) => ({ id: newOptionId(rnd), label: `${j}${"€".repeat(58)}` }));
    expect(messages(form({ fields: Array.from({ length: 30 }, () => field({ type: "choice", options })) }))).toContain(BUILDER_COPY.size);
  });
  it("errors show only for touched targets, all after a tap on the disabled Save", () => {
    const f = form({ name: "", fields: [field({ label: "" })] });
    const errs = builderErrors(f);
    expect(visibleErrors(errs, new Set(), false)).toEqual([]);
    expect(visibleErrors(errs, new Set(["form"]), false).map((e) => e.message)).toEqual([BUILDER_COPY.name]);
    expect(visibleErrors(errs, new Set(), true)).toHaveLength(2);
  });
});

describe("definition round trip", () => {
  it("archived job type ids are kept as they are", () => {
    const def = { name: "M", description: null, jobTypeIds: ["archived-jt"], required: false, fields: toDefinition(form()).fields };
    const b = fromDefinition(def);
    expect(b.appliesTo).toBe("some");
    expect(toDefinition(b).jobTypeIds).toEqual(["archived-jt"]);
    expect(toDefinition(b)).toEqual(def);
  });
});

describe("firstSaveOutcome (spec §4.1)", () => {
  it("201 → created at version 1; 200 → replay; no answer / 5xx / 429 → unknown (re-POST the same token)", () => {
    expect(firstSaveOutcome(201, { data: { id: "f1" } })).toEqual({ kind: "created", id: "f1", version: 1 });
    expect(firstSaveOutcome(200, { data: { id: "f1" } })).toEqual({ kind: "replay", id: "f1" });
    expect(firstSaveOutcome(null, null)).toEqual({ kind: "unknown" });
    expect(firstSaveOutcome(503, {})).toEqual({ kind: "unknown" });
    expect(firstSaveOutcome(409, { error: { code: "NAME_TAKEN" } })).toEqual({ kind: "refused", code: "NAME_TAKEN" });
  });
  it("a replay whose row differs from the builder stays dirty at the row's version", () => {
    const draft = toDefinition(form({ name: "Maintenance checklist v2" }));
    const row = { ...toDefinition(form()), version: 1 };
    expect(afterReplay(draft, { ...row, name: "Maintenance checklist" })).toEqual({ version: 1, dirty: true });
    expect(afterReplay(draft, { ...draft, version: 1 })).toEqual({ version: 1, dirty: false });
  });
});
```

`src/lib/admin/forms-tab.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatChangedAt, formsTabAppliesTo } from "./forms-tab";

describe("Forms tab display", () => {
  it("applies-to line", () => {
    const jt = [{ id: "a", name: "Maintenance" }, { id: "b", name: "Install (old)" }];
    expect(formsTabAppliesTo([], jt)).toBe("All requests");
    expect(formsTabAppliesTo(["a", "b"], jt)).toBe("Maintenance, Install (old)");
    expect(formsTabAppliesTo(["gone"], jt)).toBe("Some job types");
  });
  it("last changed in the business timezone", () => {
    expect(formatChangedAt("2026-11-08T03:30:00.000Z", "America/New_York")).toBe("Nov 7, 2026");
  });
});
```

`src/lib/admin/settings-tabs.test.ts`:

```diff
diff --git a/src/lib/admin/settings-tabs.test.ts b/src/lib/admin/settings-tabs.test.ts
index 9cc4967..b1c1bb9 100644
--- a/src/lib/admin/settings-tabs.test.ts
+++ b/src/lib/admin/settings-tabs.test.ts
@@ -6,6 +6,7 @@ describe('resolveSettingsTab', () => {
     expect(resolveSettingsTab('after-hours')).toBe('after-hours');
     expect(resolveSettingsTab(null)).toBe('branding');
     expect(resolveSettingsTab('nope')).toBe('branding');
+    expect(resolveSettingsTab('forms')).toBe('forms');
   });
 });
 
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/admin/form-builder.test.ts src/lib/admin/forms-tab.test.ts src/lib/admin/settings-tabs.test.ts`
Expected: FAIL — `./form-builder` and `./forms-tab` unresolved; `resolveSettingsTab('forms')` is `branding`.

- [ ] **Step 3: Pure helpers and the tab id.** `src/lib/admin/form-builder.ts`:

```ts
/**
 * Pure helpers for the office form builder (M3d spec §7.1, §8). The builder
 * keeps strings for its inputs (usual range) and converts to a
 * FormDefinition only when it saves. Client-safe.
 */
import { FORM_LIMITS, FIELD_TYPES, utf8Bytes, type FieldType, type FormDefinition, type FormField } from "@/lib/forms/form-schema";
import { numberInputState } from "@/lib/forms/form-values";

export interface BuilderOption { readonly id: string; readonly label: string }

export interface BuilderField {
  readonly id: string;
  readonly type: FieldType;
  readonly label: string;
  readonly help: string;
  readonly required: boolean;
  readonly allowNa: boolean;
  readonly unit: string;
  readonly usualMin: string;
  readonly usualMax: string;
  readonly options: readonly BuilderOption[];
}

export interface BuilderForm {
  readonly name: string;
  readonly description: string;
  readonly appliesTo: "all" | "some";
  readonly jobTypeIds: readonly string[];
  readonly required: boolean;
  readonly fields: readonly BuilderField[];
}

export const TYPE_LABELS: Record<FieldType, string> = {
  checkbox: "Checkbox",
  yes_no: "Yes / no",
  short_text: "Short answer",
  long_text: "Long answer",
  number: "Number",
  choice: "Choice",
  heading: "Heading",
};
export const TYPE_ORDER: readonly FieldType[] = FIELD_TYPES;
export const UNIT_SUGGESTIONS = ["psi", "°F", "A", "V", "µF", "inWC", "microns", "CFM"] as const;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomTail(n: number, random: () => number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return out;
}
export const newFieldId = (random: () => number = Math.random): string => `f_${randomTail(10, random)}`;
export const newOptionId = (random: () => number = Math.random): string => `o_${randomTail(8, random)}`;

export function blankField(type: FieldType = "checkbox", random: () => number = Math.random): BuilderField {
  return {
    id: newFieldId(random), type, label: "", help: "", required: false, allowNa: false, unit: "", usualMin: "", usualMax: "",
    options: type === "choice" ? [{ id: newOptionId(random), label: "" }, { id: newOptionId(random), label: "" }] : [],
  };
}

/** `New form`: empty name, one blank Checkbox question. */
export function newBuilderForm(random: () => number = Math.random): BuilderForm {
  return { name: "", description: "", appliesTo: "all", jobTypeIds: [], required: false, fields: [blankField("checkbox", random)] };
}

/** Insert a blank question after index `at` (-1 = at the top; fields.length - 1 = at the end). */
export function addField(fields: readonly BuilderField[], at: number, random: () => number = Math.random): BuilderField[] {
  const i = Math.max(-1, Math.min(at, fields.length - 1)) + 1;
  return [...fields.slice(0, i), blankField("checkbox", random), ...fields.slice(i)];
}

export function moveField(fields: readonly BuilderField[], from: number, dir: -1 | 1): BuilderField[] {
  const to = from + dir;
  if (from < 0 || from >= fields.length || to < 0 || to >= fields.length) return [...fields];
  const out = [...fields];
  [out[from], out[to]] = [out[to]!, out[from]!];
  return out;
}

export function removeField(fields: readonly BuilderField[], at: number): { fields: BuilderField[]; removed: { field: BuilderField; at: number } | null } {
  if (at < 0 || at >= fields.length) return { fields: [...fields], removed: null };
  return { fields: fields.filter((_, i) => i !== at), removed: { field: fields[at]!, at } };
}

/** Undo puts the field back where it was (or at the end if the list got shorter). */
export function restoreField(fields: readonly BuilderField[], removed: { field: BuilderField; at: number }): BuilderField[] {
  const i = Math.min(removed.at, fields.length);
  return [...fields.slice(0, i), removed.field, ...fields.slice(i)];
}

/** Keeps label and help; keeps `required` except heading → false; drops every type extra; choice seeds two empty options. */
export function changeType(field: BuilderField, type: FieldType, random: () => number = Math.random): BuilderField {
  return {
    id: field.id, type, label: field.label, help: field.help,
    required: type === "heading" ? false : field.required,
    allowNa: false, unit: "", usualMin: "", usualMax: "",
    options: type === "choice" ? [{ id: newOptionId(random), label: "" }, { id: newOptionId(random), label: "" }] : [],
  };
}

const rangeValue = (raw: string): number | undefined => {
  const s = numberInputState(raw);
  return s.kind === "value" ? s.value : undefined;
};

export function toFormFields(fields: readonly BuilderField[]): FormField[] {
  return fields.map((f): FormField => {
    const base = { id: f.id, label: f.label.trim(), required: f.type === "heading" ? false : f.required, ...(f.help.trim() ? { help: f.help.trim() } : {}) };
    switch (f.type) {
      case "yes_no":
        return { ...base, type: "yes_no", ...(f.allowNa ? { allowNa: true } : {}) };
      case "number": {
        const lo = rangeValue(f.usualMin);
        const hi = rangeValue(f.usualMax);
        return { ...base, type: "number", ...(f.unit.trim() ? { unit: f.unit.trim() } : {}), ...(lo !== undefined ? { usualMin: lo } : {}), ...(hi !== undefined ? { usualMax: hi } : {}) };
      }
      case "choice":
        return { ...base, type: "choice", options: f.options.map((o) => ({ id: o.id, label: o.label.trim() })) };
      default:
        return { ...base, type: f.type };
    }
  });
}

export function toDefinition(form: BuilderForm): FormDefinition {
  return {
    name: form.name.trim(),
    description: form.description.trim() === "" ? null : form.description.trim(),
    jobTypeIds: form.appliesTo === "all" ? [] : [...form.jobTypeIds],
    required: form.required,
    fields: toFormFields(form.fields),
  };
}

/** The loaded row as builder state (archived job type ids are kept as they are). */
export function fromDefinition(d: {
  readonly name: string;
  readonly description: string | null;
  readonly jobTypeIds: readonly string[];
  readonly required: boolean;
  readonly fields: readonly FormField[];
}): BuilderForm {
  return {
    name: d.name,
    description: d.description ?? "",
    appliesTo: d.jobTypeIds.length === 0 ? "all" : "some",
    jobTypeIds: [...d.jobTypeIds],
    required: d.required,
    fields: d.fields.map((f) => ({
      id: f.id, type: f.type, label: f.label, help: f.help ?? "", required: f.required,
      allowNa: f.type === "yes_no" ? f.allowNa === true : false,
      unit: f.type === "number" ? f.unit ?? "" : "",
      usualMin: f.type === "number" && f.usualMin !== undefined ? String(f.usualMin) : "",
      usualMax: f.type === "number" && f.usualMax !== undefined ? String(f.usualMax) : "",
      options: f.type === "choice" ? f.options.map((o) => ({ id: o.id, label: o.label })) : [],
    })),
  };
}

export const sameDefinition = (a: FormDefinition, b: FormDefinition): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface BuilderError {
  /** "form" for header rules, else the field id the rule is about. */
  readonly target: "form" | string;
  readonly message: string;
}

export const BUILDER_COPY = {
  name: "Give the form a name.",
  nameLong: "Keep the name to 80 characters or fewer.",
  descriptionLong: "Keep the description to 300 characters or fewer.",
  noQuestion: "Add at least one question.",
  tooMany: "Up to 60 questions and headings.",
  longText: "Up to 10 long answers per form.",
  label: "Add a label.",
  labelLong: "Keep the label to 120 characters or fewer.",
  helpLong: "Keep the help to 200 characters or fewer.",
  unitLong: "Keep the unit to 12 characters or fewer.",
  fewOptions: "Add at least two options.",
  manyOptions: "Up to 12 options.",
  optionLabel: "Each option needs a label.",
  optionLong: "Keep each option to 60 characters or fewer.",
  optionDuplicate: "Two options have the same label.",
  range: "The low end can't be above the high end.",
  rangeNumber: "Enter a number like 12.5 (up to 3 decimal places).",
  jobTypes: "Pick at least one job type, or choose All requests.",
  size: "This form is too large. Remove some questions.",
} as const;

/** One message per broken rule (spec §8), in form order. */
export function builderErrors(form: BuilderForm): BuilderError[] {
  const out: BuilderError[] = [];
  const add = (target: string, message: string) => out.push({ target, message });
  const name = form.name.trim();
  if (name === "") add("form", BUILDER_COPY.name);
  if (name.length > FORM_LIMITS.name) add("form", BUILDER_COPY.nameLong);
  if (form.description.trim().length > FORM_LIMITS.description) add("form", BUILDER_COPY.descriptionLong);
  if (form.appliesTo === "some" && form.jobTypeIds.length === 0) add("form", BUILDER_COPY.jobTypes);
  if (!form.fields.some((f) => f.type !== "heading")) add("form", BUILDER_COPY.noQuestion);
  if (form.fields.length > FORM_LIMITS.maxFields) add("form", BUILDER_COPY.tooMany);
  if (form.fields.filter((f) => f.type === "long_text").length > FORM_LIMITS.maxLongText) add("form", BUILDER_COPY.longText);
  for (const f of form.fields) {
    const label = f.label.trim();
    if (label === "") add(f.id, BUILDER_COPY.label);
    if (label.length > FORM_LIMITS.label) add(f.id, BUILDER_COPY.labelLong);
    if (f.help.trim().length > FORM_LIMITS.help) add(f.id, BUILDER_COPY.helpLong);
    if (f.type === "number") {
      if (f.unit.trim().length > FORM_LIMITS.unit) add(f.id, BUILDER_COPY.unitLong);
      const lo = numberInputState(f.usualMin);
      const hi = numberInputState(f.usualMax);
      if ((lo.kind !== "empty" && lo.kind !== "value") || (hi.kind !== "empty" && hi.kind !== "value")) add(f.id, BUILDER_COPY.rangeNumber);
      else if (lo.kind === "value" && hi.kind === "value" && lo.value > hi.value) add(f.id, BUILDER_COPY.range);
    }
    if (f.type === "choice") {
      if (f.options.length < FORM_LIMITS.minOptions) add(f.id, BUILDER_COPY.fewOptions);
      if (f.options.length > FORM_LIMITS.maxOptions) add(f.id, BUILDER_COPY.manyOptions);
      const labels = f.options.map((o) => o.label.trim());
      if (labels.some((l) => l === "")) add(f.id, BUILDER_COPY.optionLabel);
      if (labels.some((l) => l.length > FORM_LIMITS.optionLabel)) add(f.id, BUILDER_COPY.optionLong);
      const filled = labels.filter((l) => l !== "").map((l) => l.toLowerCase());
      if (new Set(filled).size !== filled.length) add(f.id, BUILDER_COPY.optionDuplicate);
    }
  }
  if (utf8Bytes(JSON.stringify(toFormFields(form.fields))) > FORM_LIMITS.definitionBytes) add("form", BUILDER_COPY.size);
  return out;
}

/** Errors shown under "Fix these to save:": touched targets only, or all after a tap on the disabled Save. */
export function visibleErrors(errors: readonly BuilderError[], touched: ReadonlySet<string>, showAll: boolean): BuilderError[] {
  return showAll ? [...errors] : errors.filter((e) => touched.has(e.target));
}

export type FirstSaveOutcome =
  | { readonly kind: "created"; readonly id: string; readonly version: 1 }
  | { readonly kind: "replay"; readonly id: string }
  | { readonly kind: "unknown" }
  | { readonly kind: "refused"; readonly code: string };

/** The first Save's answer (spec §4.1). `status` null = no answer (network). */
export function firstSaveOutcome(status: number | null, body: unknown): FirstSaveOutcome {
  const env = (body ?? {}) as { data?: { id?: unknown }; error?: { code?: unknown } };
  const id = typeof env.data?.id === "string" ? env.data.id : null;
  if (status === 201 && id) return { kind: "created", id, version: 1 };
  if (status === 200 && id) return { kind: "replay", id };
  if (status === null || status >= 500 || status === 429 || ((status === 200 || status === 201) && !id)) return { kind: "unknown" };
  return { kind: "refused", code: typeof env.error?.code === "string" ? env.error.code : "UNKNOWN" };
}

/** After a 200 replay the builder GETs the row: it continues as an edit at the row's version, dirty when its own state differs. */
export function afterReplay(draft: FormDefinition, row: FormDefinition & { version: number }): { version: number; dirty: boolean } {
  const { version, ...rowDef } = row;
  return { version, dirty: !sameDefinition(draft, rowDef) };
}
```

`src/lib/admin/forms-tab.ts`:

```ts
/** Pure display rules for the Settings → Forms tab (M3d spec §7.1). Client-safe. */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";

/** "All requests", else the job type names (archived ones included: the list comes from the full job types GET). */
export function formsTabAppliesTo(ids: readonly string[], jobTypes: ReadonlyArray<{ readonly id: string; readonly name: string }>): string {
  if (ids.length === 0) return "All requests";
  const byId = new Map(jobTypes.map((j) => [j.id, j.name]));
  const names = ids.map((id) => byId.get(id)).filter((n): n is string => n !== undefined);
  return names.length > 0 ? names.join(", ") : "Some job types";
}

/** "Nov 7, 2026" in the business timezone. */
export function formatChangedAt(iso: string, timeZone: string = BUSINESS_BASE_LOCATION.timezone): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}
```

```diff
diff --git a/src/lib/admin/settings-tabs.ts b/src/lib/admin/settings-tabs.ts
index 189feb1..918fbab 100644
--- a/src/lib/admin/settings-tabs.ts
+++ b/src/lib/admin/settings-tabs.ts
@@ -3,6 +3,7 @@ export const SETTINGS_TABS = [
   'branding',
   'services',
   'job-types',
+  'forms',
   'tags',
   'business',
   'faqs',
```

- [ ] **Step 4: Run them to verify they pass**

Run: the Step 2 command. Expected: PASS (form-builder 12, forms-tab 2, settings-tabs 2).

- [ ] **Step 5: The UI.** `src/components/admin/settings/forms-panel.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ListChecks, Plus } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionCard } from '@/components/admin/ui/section-card';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { LoadErrorState } from '@/components/admin/ui/load-error-state';
import { plural } from '@/lib/format/plural';
import type { FormListRow } from '@/lib/admin/form-queries';
import type { JobTypeRecord } from '@/lib/admin/job-type-types';
import { formsTabAppliesTo, formatChangedAt } from '@/lib/admin/forms-tab';

/** Settings → Forms (M3d spec §7.1): active forms by name, archived last. */
export function FormsPanel() {
  const [forms, setForms] = useState<readonly FormListRow[] | null>(null);
  const [jobTypes, setJobTypes] = useState<readonly JobTypeRecord[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [fr, jr] = await Promise.all([fetch('/api/admin/settings/forms'), fetch('/api/admin/settings/job-types')]);
        const [fb, jb] = await Promise.all([fr.json(), jr.json().catch(() => null)]);
        if (!live) return;
        if (!fr.ok || !fb?.success) {
          setFailed(true);
          return;
        }
        setForms(fb.data.forms as FormListRow[]);
        setJobTypes(jr.ok && jb?.success ? (jb.data.jobTypes as JobTypeRecord[]) : []);
        setFailed(false);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [attempt]);

  const newButton = (
    <Link href="/admin/settings/forms/new" className={buttonVariants({ size: 'sm' })}>
      <Plus className="size-4" aria-hidden="true" /> New form
    </Link>
  );

  if (failed && forms === null) {
    return <LoadErrorState title="Couldn't load forms." onRetry={() => setAttempt((n) => n + 1)} />;
  }

  return (
    <SectionCard title="Forms" icon={ListChecks} count={forms?.length} action={forms && forms.length > 0 ? newButton : undefined}>
      {forms === null ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : forms.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No forms yet."
          description="Forms you build here show in the technician app."
          action={newButton}
        />
      ) : (
        <ul className="divide-y">
          {forms.map((f) => (
            <li key={f.id}>
              <Link href={`/admin/settings/forms/${f.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm hover:bg-surface-sunken">
                <span className={f.active ? 'font-medium' : 'font-medium text-muted-foreground'}>{f.name}</span>
                <span className="text-muted-foreground">{plural(f.questionCount, 'question', 'questions')}</span>
                <span className="text-muted-foreground">{formsTabAppliesTo(f.jobTypeIds, jobTypes)}</span>
                {f.required && <span className="rounded-[3px] border px-1.5 py-0.5 text-xs font-medium">Required</span>}
                {!f.active && <span className="rounded-[3px] border px-1.5 py-0.5 text-xs text-muted-foreground">Archived</span>}
                <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">{formatChangedAt(f.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
```

`src/components/admin/forms/form-field-editor.tsx`:

```tsx
'use client';

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FORM_LIMITS, type FieldType } from '@/lib/forms/form-schema';
import { changeType, newOptionId, TYPE_LABELS, TYPE_ORDER, UNIT_SUGGESTIONS, type BuilderField } from '@/lib/admin/form-builder';

const TYPE_ITEMS = TYPE_ORDER.map((t) => ({ value: t, label: TYPE_LABELS[t] }));

/** One question in the builder (M3d spec §7.1). Pure presentation: every change goes through `onChange`. */
export function FormFieldEditor({
  field,
  index,
  count,
  longTextFull,
  canAdd,
  errors,
  onChange,
  onMove,
  onAddBelow,
  onRemove,
}: {
  readonly field: BuilderField;
  readonly index: number;
  readonly count: number;
  /** 10 long answers already: `Long answer` is disabled for other questions. */
  readonly longTextFull: boolean;
  readonly canAdd: boolean;
  readonly errors: readonly string[];
  readonly onChange: (next: BuilderField) => void;
  readonly onMove: (dir: -1 | 1) => void;
  readonly onAddBelow: () => void;
  readonly onRemove: () => void;
}) {
  const set = (patch: Partial<BuilderField>) => onChange({ ...field, ...patch });
  const isHeading = field.type === 'heading';
  return (
    <li id={`field-${field.id}`} className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{index + 1}</span>
        <Select
          items={TYPE_ITEMS}
          value={field.type}
          onValueChange={(v) => v && v !== field.type && onChange(changeType(field, v as FieldType))}
        >
          <SelectTrigger aria-label="Question type" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPE_ITEMS.map((t) => (
              <SelectItem key={t.value} value={t.value} disabled={t.value === 'long_text' && longTextFull && field.type !== 'long_text'}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="size-4" />
          </Button>
          <Button type="button" size="sm" variant="ghost" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown className="size-4" />
          </Button>
          <Button type="button" size="sm" variant="ghost" aria-label="Remove" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <Input aria-label="Label" placeholder={isHeading ? 'Section title' : 'Question'} value={field.label} maxLength={FORM_LIMITS.label + 20} onChange={(e) => set({ label: e.target.value })} />
      <Input aria-label="Help" placeholder="Help (optional)" value={field.help} onChange={(e) => set({ help: e.target.value })} />

      {!isHeading && (
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={field.required} onCheckedChange={(v) => set({ required: v })} aria-label="Required" />
          Required
        </label>
      )}

      {field.type === 'yes_no' && (
        <label className="flex items-start gap-2 text-sm">
          <Switch checked={field.allowNa} onCheckedChange={(v) => set({ allowNa: v })} aria-label="Allow N/A" />
          <span>
            Allow N/A
            <span className="block text-xs text-muted-foreground">Use N/A for items that don&apos;t apply to every system.</span>
          </span>
        </label>
      )}

      {field.type === 'number' && (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Unit</span>
            <Input list={`units-${field.id}`} value={field.unit} onChange={(e) => set({ unit: e.target.value })} />
            <datalist id={`units-${field.id}`}>
              {UNIT_SUGGESTIONS.map((u) => <option key={u} value={u} />)}
            </datalist>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Usual range from</span>
            <Input inputMode="decimal" value={field.usualMin} onChange={(e) => set({ usualMin: e.target.value })} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">to</span>
            <Input inputMode="decimal" value={field.usualMax} onChange={(e) => set({ usualMax: e.target.value })} />
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-3">Readings outside it are still saved, with a note.</p>
        </div>
      )}

      {field.type === 'choice' && (
        <div className="space-y-2">
          {field.options.map((o, i) => (
            <div key={o.id} className="flex items-center gap-2">
              <Input
                aria-label={`Option ${i + 1}`}
                value={o.label}
                onChange={(e) => set({ options: field.options.map((x) => (x.id === o.id ? { ...x, label: e.target.value } : x)) })}
              />
              <Button
                type="button" size="sm" variant="ghost" aria-label={`Remove option ${i + 1}`}
                onClick={() => set({ options: field.options.filter((x) => x.id !== o.id) })}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button" size="sm" variant="outline" disabled={field.options.length >= FORM_LIMITS.maxOptions}
            onClick={() => set({ options: [...field.options, { id: newOptionId(), label: '' }] })}
          >
            <Plus className="size-4" /> Add option
          </Button>
        </div>
      )}

      {errors.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive">
          {errors.map((m) => <li key={m}>{m}</li>)}
        </ul>
      )}

      <Button type="button" size="sm" variant="ghost" disabled={!canAdd} onClick={onAddBelow}>
        <Plus className="size-4" /> Add question below
      </Button>
    </li>
  );
}
```

`src/components/admin/forms/form-builder-client.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { SectionCard } from '@/components/admin/ui/section-card';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { FormFieldEditor } from '@/components/admin/forms/form-field-editor';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { LEAVE_UNSAVED_COPY, LEAVE_UNSAVED_TITLE } from '@/lib/admin/unsaved-changes';
import { mintKey } from '@/lib/http/idempotency-codes';
import { FORM_LIMITS } from '@/lib/forms/form-schema';
import { FORM_OFFICE_COPY } from '@/lib/admin/form-route-copy';
import {
  addField, afterReplay, builderErrors, firstSaveOutcome, fromDefinition, moveField, newBuilderForm, removeField, restoreField,
  sameDefinition, toDefinition, visibleErrors, type BuilderField, type BuilderForm,
} from '@/lib/admin/form-builder';
import type { FormRecord } from '@/lib/admin/form-queries';
import type { JobTypeRecord } from '@/lib/admin/job-type-types';

const SAVE_FAILED = "Couldn't save the form. Please try again.";
const SAVE_FIRST = 'Save or discard your changes first.';
const UNDO_MS = 5000;

const REFUSAL_COPY: Record<string, string> = {
  NAME_TAKEN: FORM_OFFICE_COPY.NAME_TAKEN,
  LIMIT_REACHED: FORM_OFFICE_COPY.LIMIT_REACHED,
  UNKNOWN_JOB_TYPE: FORM_OFFICE_COPY.UNKNOWN_JOB_TYPE,
  STALE: FORM_OFFICE_COPY.STALE,
};

async function call(url: string, init?: RequestInit): Promise<{ status: number | null; body: unknown }> {
  try {
    const res = await fetch(url, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: null, body: null };
  }
}

const errorCode = (body: unknown): string | null => {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : null;
};

/** Office form builder (M3d spec §4.1, §7.1). `formId` null = New form (not inserted until the first valid Save). */
export function FormBuilderClient({ formId: initialId }: { readonly formId: string | null }) {
  const [formId, setFormId] = useState<string | null>(initialId);
  const [version, setVersion] = useState<number | null>(null);
  const [active, setActive] = useState(true);
  const [submissionCount, setSubmissionCount] = useState(0);
  const [loaded, setLoaded] = useState<BuilderForm | null>(initialId === null ? newBuilderForm() : null);
  const [draft, setDraft] = useState<BuilderForm | null>(loaded);
  const [loadFailed, setLoadFailed] = useState(false);
  const [jobTypes, setJobTypes] = useState<readonly JobTypeRecord[] | null>(null);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [undo, setUndo] = useState<{ field: BuilderField; at: number } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Minted once when the builder opens; every retry of the first Save reuses it.
  const clientToken = useRef<string>(mintKey());

  const applyRow = useCallback((row: { form: FormRecord; submissionCount: number }) => {
    const b = fromDefinition(row.form);
    setLoaded(b);
    setDraft(b);
    setVersion(row.form.version);
    setActive(row.form.active);
    setSubmissionCount(row.submissionCount);
    setTouched(new Set());
    setShowAll(false);
    setStale(false);
    setMessage(null);
  }, []);

  const loadRow = useCallback(async (id: string): Promise<{ form: FormRecord; submissionCount: number } | null> => {
    const r = await call(`/api/admin/settings/forms/${id}`);
    const data = (r.body as { success?: boolean; data?: { form: FormRecord; submissionCount: number } } | null);
    return r.status === 200 && data?.success && data.data ? data.data : null;
  }, []);

  useEffect(() => {
    void (async () => {
      const r = await call('/api/admin/settings/job-types');
      const data = r.body as { success?: boolean; data?: { jobTypes: JobTypeRecord[] } } | null;
      setJobTypes(r.status === 200 && data?.success && data.data ? data.data.jobTypes : []);
    })();
    if (initialId === null) return;
    void (async () => {
      const row = await loadRow(initialId);
      if (row) applyRow(row);
      else setLoadFailed(true);
    })();
  }, [initialId, loadRow, applyRow]);

  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  const errors = useMemo(() => (draft ? builderErrors(draft) : []), [draft]);
  // A New form compares against its own blank start, so an untouched one isn't "unsaved" (spec §7.1).
  const dirty = useMemo(
    () => draft !== null && loaded !== null && !sameDefinition(toDefinition(draft), toDefinition(loaded)),
    [draft, loaded],
  );
  const leaveGuard = useUnsavedChangesGuard(dirty);

  const edit = (target: string, next: BuilderForm) => {
    setDraft(next);
    setTouched((t) => (t.has(target) ? t : new Set([...t, target])));
    setMessage(null);
  };
  const editField = (index: number, next: BuilderField) => {
    if (!draft) return;
    edit(next.id, { ...draft, fields: draft.fields.map((f, i) => (i === index ? next : f)) });
  };

  async function save(): Promise<void> {
    if (!draft || saving) return;
    if (errors.length > 0 || !dirty) {
      setShowAll(true);
      return;
    }
    setSaving(true);
    setMessage(null);
    const def = toDefinition(draft);
    try {
      // A replay whose GET failed left the id without a version: read the row before PATCHing.
      let base = version;
      if (formId !== null && base === null) {
        const row = await loadRow(formId);
        if (!row) {
          setMessage(SAVE_FAILED);
          return;
        }
        base = row.form.version;
        setVersion(base);
        setLoaded(fromDefinition(row.form));
        setSubmissionCount(row.submissionCount);
      }
      if (formId === null) {
        const r = await call('/api/admin/settings/forms', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientToken: clientToken.current, ...def }),
        });
        const out = firstSaveOutcome(r.status, r.body);
        if (out.kind === 'created') {
          setFormId(out.id);
          setVersion(out.version);
          setLoaded(draft);
          // Native history keeps this component mounted (Next 16 integrates replaceState).
          window.history.replaceState(null, '', `/admin/settings/forms/${out.id}`);
        } else if (out.kind === 'replay') {
          const row = await loadRow(out.id);
          setFormId(out.id);
          window.history.replaceState(null, '', `/admin/settings/forms/${out.id}`);
          if (row) {
            const next = afterReplay(def, { ...toDefinition(fromDefinition(row.form)), version: row.form.version });
            setVersion(next.version);
            setLoaded(fromDefinition(row.form));
            setSubmissionCount(row.submissionCount);
          } else {
            setMessage(SAVE_FAILED);
          }
        } else if (out.kind === 'unknown') {
          setMessage(SAVE_FAILED);
        } else {
          setMessage(REFUSAL_COPY[out.code] ?? SAVE_FAILED);
        }
        return;
      }
      const r = await call(`/api/admin/settings/forms/${formId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: base, definition: def }),
      });
      const v = (r.body as { data?: { version?: number } } | null)?.data?.version;
      if (r.status === 200 && typeof v === 'number') {
        setVersion(v);
        setLoaded(draft);
        return;
      }
      const code = errorCode(r.body);
      if (code === 'STALE') setStale(true);
      setMessage((code && REFUSAL_COPY[code]) ?? SAVE_FAILED);
    } finally {
      setSaving(false);
    }
  }

  async function setArchived(nextActive: boolean): Promise<void> {
    if (!formId || version === null) return;
    if (dirty) {
      setMessage(SAVE_FIRST);
      return;
    }
    setSaving(true);
    const r = await call(`/api/admin/settings/forms/${formId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version, active: nextActive }),
    });
    setSaving(false);
    setArchiveOpen(false);
    const v = (r.body as { data?: { version?: number } } | null)?.data?.version;
    if (r.status === 200 && typeof v === 'number') {
      setVersion(v);
      setActive(nextActive);
      return;
    }
    const code = errorCode(r.body);
    if (code === 'STALE') setStale(true);
    setMessage((code && REFUSAL_COPY[code]) ?? SAVE_FAILED);
  }

  async function reload(): Promise<void> {
    if (!formId) return;
    const row = await loadRow(formId);
    if (row) applyRow(row);
  }

  function remove(index: number): void {
    if (!draft) return;
    const r = removeField(draft.fields, index);
    if (!r.removed) return;
    edit('form', { ...draft, fields: r.fields });
    setUndo(r.removed);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
  }

  if (loadFailed) {
    return (
      <PageShell narrow>
        <PageHeader title="Form" back={{ href: '/admin/settings?tab=forms', label: 'Back to forms' }} />
        <p role="alert" className="text-sm text-destructive">Couldn&apos;t load this form.</p>
      </PageShell>
    );
  }
  if (!draft || jobTypes === null) {
    return (
      <PageShell narrow>
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </PageShell>
    );
  }

  const shown = visibleErrors(errors, touched, showAll);
  const formErrors = shown.filter((e) => e.target === 'form').map((e) => e.message);
  const longTextCount = draft.fields.filter((f) => f.type === 'long_text').length;
  const activeTypes = jobTypes.filter((j) => j.active);
  const archivedPicked = jobTypes.filter((j) => !j.active && draft.jobTypeIds.includes(j.id));
  const toggleJobType = (id: string, on: boolean) =>
    edit('form', { ...draft, jobTypeIds: on ? [...draft.jobTypeIds, id] : draft.jobTypeIds.filter((x) => x !== id) });

  return (
    <PageShell narrow>
      <PageHeader
        title={draft.name.trim() || 'New form'}
        back={{ href: '/admin/settings?tab=forms', label: 'Back to forms' }}
        actions={formId && (
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => (active ? (dirty ? setMessage(SAVE_FIRST) : setArchiveOpen(true)) : void setArchived(true))}>
            {active ? 'Archive' : 'Restore'}
          </Button>
        )}
      />

      <SectionCard title="Form">
        <div id="form-header" className="space-y-4 p-4">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Name</span>
            <Input value={draft.name} onChange={(e) => edit('form', { ...draft, name: e.target.value })} />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Description</span>
            <Textarea rows={2} value={draft.description} onChange={(e) => edit('form', { ...draft, description: e.target.value })} />
          </label>
          <fieldset className="space-y-2 text-sm">
            <legend className="font-medium">Applies to</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="applies" checked={draft.appliesTo === 'all'} onChange={() => edit('form', { ...draft, appliesTo: 'all' })} />
              All requests
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="applies" checked={draft.appliesTo === 'some'} onChange={() => edit('form', { ...draft, appliesTo: 'some' })} />
              Some job types
            </label>
            {draft.appliesTo === 'some' && (
              jobTypes.length === 0 ? (
                <p className="text-muted-foreground">No job types yet. Add them on the Job types tab.</p>
              ) : (
                <div className="grid gap-1 pl-6 sm:grid-cols-2">
                  {[...activeTypes, ...archivedPicked].map((j) => (
                    <label key={j.id} className="flex items-center gap-2">
                      <input type="checkbox" checked={draft.jobTypeIds.includes(j.id)} onChange={(e) => toggleJobType(j.id, e.target.checked)} />
                      {j.active ? j.name : `${j.name} (archived)`}
                    </label>
                  ))}
                </div>
              )
            )}
          </fieldset>
          <label className="flex items-start gap-2 text-sm">
            <Switch checked={draft.required} onCheckedChange={(v) => edit('form', { ...draft, required: v })} aria-label="Required form" />
            <span>
              Required form
              <span className="block text-xs text-muted-foreground">
                Technicians see this form as Required and are reminded before closing out. Nothing is blocked.
              </span>
            </span>
          </label>
          {formErrors.length > 0 && (
            <ul className="space-y-0.5 text-xs text-destructive">{formErrors.map((m) => <li key={m}>{m}</li>)}</ul>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Questions" count={draft.fields.length}>
        <ol className="divide-y">
          {draft.fields.map((f, i) => (
            <FormFieldEditor
              key={f.id}
              field={f}
              index={i}
              count={draft.fields.length}
              longTextFull={longTextCount >= FORM_LIMITS.maxLongText}
              canAdd={draft.fields.length < FORM_LIMITS.maxFields}
              errors={shown.filter((e) => e.target === f.id).map((e) => e.message)}
              onChange={(next) => editField(i, next)}
              onMove={(dir) => edit('form', { ...draft, fields: moveField(draft.fields, i, dir) })}
              onAddBelow={() => edit('form', { ...draft, fields: addField(draft.fields, i) })}
              onRemove={() => remove(i)}
            />
          ))}
        </ol>
        <div className="space-y-2 border-t p-4">
          {undo && (
            <p role="status" className="flex items-center gap-2 text-sm">
              Question removed.
              <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft({ ...draft, fields: restoreField(draft.fields, undo) }); setUndo(null); }}>
                Undo
              </Button>
            </p>
          )}
          <Button type="button" variant="outline" size="sm" disabled={draft.fields.length >= FORM_LIMITS.maxFields} onClick={() => edit('form', { ...draft, fields: addField(draft.fields, draft.fields.length - 1) })}>
            <Plus className="size-4" /> Add question
          </Button>
          <p className="text-xs text-muted-foreground">Need a photo? Ask technicians to add it in the technician app&apos;s Photos card.</p>
        </div>
      </SectionCard>

      <div className="space-y-2">
        {submissionCount > 0 && <p className="text-sm text-muted-foreground">Forms already started keep the earlier version.</p>}
        {shown.length > 0 && (
          <div role="alert" className="text-sm">
            <p className="font-medium">Fix these to save:</p>
            <ul className="list-disc pl-5">
              {shown.map((e) => (
                <li key={`${e.target}-${e.message}`}>
                  <a className="underline" href={e.target === 'form' ? '#form-header' : `#field-${e.target}`}>{e.message}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        {message && (
          <p role="alert" className="text-sm text-destructive">
            {message}{' '}
            {stale && <Button type="button" size="sm" variant="ghost" onClick={() => void reload()}>Reload</Button>}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {/* A tap on the disabled Save shows every reason (disabled buttons get no clicks). */}
          <div onClick={() => (errors.length > 0 ? setShowAll(true) : undefined)}>
            <Button type="button" disabled={saving || errors.length > 0 || !dirty} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {formId && dirty && loaded && (
            <Button type="button" variant="outline" disabled={saving} onClick={() => { setDraft(loaded); setTouched(new Set()); setShowAll(false); setMessage(null); }}>
              Discard changes
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive this form?"
        description="Technicians can't start it any more. Forms already started can still be finished, and answers are kept."
        confirmLabel="Archive"
        isConfirming={saving}
        onConfirm={() => void setArchived(false)}
      />
      <ConfirmDialog
        open={leaveGuard.pendingHref !== null}
        onOpenChange={(open) => { if (!open) leaveGuard.stay(); }}
        title={LEAVE_UNSAVED_TITLE}
        description={LEAVE_UNSAVED_COPY}
        confirmLabel="Leave"
        cancelLabel="Keep editing"
        onConfirm={leaveGuard.leave}
      />
    </PageShell>
  );
}
```

`src/app/admin/(dashboard)/settings/forms/[id]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { FormBuilderClient } from '@/components/admin/forms/form-builder-client';
import { isUuid } from '@/lib/validation/uuid';

/**
 * The office form builder (M3d spec §7.1). `/admin/settings/forms/new` is this
 * page with no row: nothing is inserted until the first valid Save. Next.js 16:
 * params is a Promise.
 */
export default async function FormBuilderPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id !== 'new' && !isUuid(id)) notFound();
  return <FormBuilderClient formId={id === 'new' ? null : id.toLowerCase()} />;
}
```

`src/app/admin/(dashboard)/settings/page.tsx` (re-read first):

```diff
diff --git a/src/app/admin/(dashboard)/settings/page.tsx b/src/app/admin/(dashboard)/settings/page.tsx
index b0153c7..ff3c2cc 100644
--- a/src/app/admin/(dashboard)/settings/page.tsx
+++ b/src/app/admin/(dashboard)/settings/page.tsx
@@ -14,6 +14,7 @@ import {
   Plug,
   Truck,
   ClipboardList,
+  ListChecks,
   Tag,
 } from 'lucide-react';
 import { useOrgSettings } from '@/hooks/use-org-settings';
@@ -35,6 +36,7 @@ import { AiModelPanel } from '@/components/admin/settings/ai-model-panel';
 import { PlatformLinkPanel } from '@/components/admin/settings/platform-link-panel';
 import { TagsPanel } from '@/components/admin/settings/tags-panel';
 import { JobTypesPanel } from '@/components/admin/settings/job-types-panel';
+import { FormsPanel } from '@/components/admin/settings/forms-panel';
 import { BillingLinkPanel } from '@/components/admin/settings/billing-link-panel';
 import { PageShell } from '@/components/admin/ui/page-shell';
 import { PageHeader } from '@/components/admin/ui/page-header';
@@ -153,6 +155,10 @@ export default function SettingsPage() {
               <ClipboardList className="size-4" />
               Job types
             </TabsTrigger>
+            <TabsTrigger value="forms">
+              <ListChecks className="size-4" />
+              Forms
+            </TabsTrigger>
             <TabsTrigger value="tags">
               <Tag className="size-4" />
               Tags
@@ -209,6 +215,9 @@ export default function SettingsPage() {
           <TabsContent value="job-types" className="mt-6">
             <JobTypesPanel />
           </TabsContent>
+          <TabsContent value="forms" className="mt-6">
+            <FormsPanel />
+          </TabsContent>
           <TabsContent value="tags" className="mt-6">
             <TagsPanel />
           </TabsContent>
```

- [ ] **Step 6: Walk it (1440).** Dev server running. Read `.claude/skills/page-settings/SKILL.md` and `admin-pages` first. `walk-m3d-9.mts` at the repo root (seeds a throwaway org through the Task 8 fixture, deletes it in `finally`):

```ts
/** Task 9 walk (1440): admin builds "Maintenance checklist", the URL becomes the form's, the tab lists it. Deleted before commit. */
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const env = { ...process.env, NODE_OPTIONS: "--conditions=react-server" };
const fx = JSON.parse(execFileSync("npx", ["tsx", "scripts/agent/m3d-walk.mts", "seed"], { encoding: "utf8", env }).trim().split("\n").pop()!) as {
  org: string; tokens: { admin: string };
};
const BASE = "http://localhost:3000";
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: "hvac_admin_session", value: fx.tokens.admin, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/settings?tab=forms`);
  await page.getByText("No forms yet.").waitFor();
  await page.screenshot({ path: "/tmp/m3d-9-empty.png" });
  await page.getByRole("link", { name: "New form" }).first().click();
  await page.waitForURL("**/admin/settings/forms/new");
  await page.getByRole("button", { name: "Save" }).click({ force: true }); // disabled: shows every reason
  await page.getByText("Fix these to save:").waitFor();
  await page.screenshot({ path: "/tmp/m3d-9-errors.png" });
  await page.getByLabel("Name").fill("Maintenance checklist");
  const labels = ["Filter changed", "Coil cleaned", "Drain flushed", "Thermostat checked"];
  for (let i = 0; i < labels.length; i++) {
    if (i > 0) await page.getByRole("button", { name: "Add question", exact: true }).click();
    await page.getByLabel("Label").nth(i).fill(labels[i]!);
  }
  // exact: "Required" is also a substring of the "Required form" switch's label.
  await page.getByLabel("Required", { exact: true }).nth(0).click();
  await page.getByLabel("Required", { exact: true }).nth(1).click();
  await page.getByRole("button", { name: "Add question", exact: true }).click();
  await page.getByLabel("Question type").nth(4).click();
  await page.getByRole("option", { name: "Number" }).click();
  await page.getByLabel("Label").nth(4).fill("Suction pressure");
  await page.getByLabel("Unit").fill("psi");
  await page.getByLabel("Usual range from").fill("100");
  await page.getByLabel("to", { exact: true }).fill("140");
  await page.getByLabel("Required form").click();
  await page.screenshot({ path: "/tmp/m3d-9-builder.png", fullPage: true });
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/\/admin\/settings\/forms\/[0-9a-f-]{36}$/);
  await page.goto(`${BASE}/admin/settings?tab=forms`);
  await page.getByText("Maintenance checklist").waitFor();
  await page.getByText("5 questions").waitFor();
  await page.screenshot({ path: "/tmp/m3d-9-list.png" });
  console.log(JSON.stringify({ ok: true, org: fx.org }));
} finally {
  await browser.close();
  execFileSync("npx", ["tsx", "scripts/agent/m3d-walk.mts", "delete", fx.org], { encoding: "utf8", env, stdio: "inherit" });
}
```

Run `npx tsx walk-m3d-9.mts`. Expected: `{"ok":true,…}` then `{"deleted":…}`. Look at `/tmp/m3d-9-empty.png` (empty state + New form), `/tmp/m3d-9-errors.png` ("Fix these to save:" with "Give the form a name." after the tap on the disabled Save), `/tmp/m3d-9-builder.png` (five questions, the number row's Unit and Usual range, Required form on), `/tmp/m3d-9-list.png` (one row: "Maintenance checklist · 5 questions · All requests · Required"). Also by hand: an untouched New form leaves through `Back to forms` without a prompt; leave the builder with a change through `Back to forms` → the "Leave without saving?" dialog; Archive while dirty → "Save or discard your changes first.". Delete the walk script.

- [ ] **Step 7: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/form-builder.ts src/lib/admin/form-builder.test.ts src/lib/admin/forms-tab.ts src/lib/admin/forms-tab.test.ts src/lib/admin/settings-tabs.ts src/lib/admin/settings-tabs.test.ts src/components/admin/settings/forms-panel.tsx src/components/admin/forms "src/app/admin/(dashboard)/settings" && npx vitest run
git add src/lib/admin/form-builder.ts src/lib/admin/form-builder.test.ts src/lib/admin/forms-tab.ts src/lib/admin/forms-tab.test.ts src/lib/admin/settings-tabs.ts src/lib/admin/settings-tabs.test.ts src/components/admin/settings/forms-panel.tsx src/components/admin/forms/form-field-editor.tsx src/components/admin/forms/form-builder-client.tsx "src/app/admin/(dashboard)/settings/forms/[id]/page.tsx" "src/app/admin/(dashboard)/settings/page.tsx"
git commit -m "$(cat <<'EOF'
feat(m3d): Settings Forms tab and the form builder (first Save by client token, CAS edits, archive)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 10a: Technician fill — the pure modules (answer bookkeeping, autosave timing, copy)

**Files:**
- Create: `src/lib/tech/form-fill-state.ts`, `src/lib/tech/form-fill-state.test.ts`, `src/lib/tech/form-save-machine.ts`, `src/lib/tech/form-save-machine.test.ts`, `src/lib/tech/form-copy.ts`, `src/lib/tech/form-copy.test.ts`

**Interfaces:**
- Consumes: Task 2 field model and values (`numberInputState`, `applyChanges`, `carryValues`, `mergeDraft`, `missingRequired`, `stripControlChars`, `Changes`, `FieldValue`, `FormValues`), `plural`; Task 3 `WriteBlockedReason`; Task 7 `CardForm`; `MAY_NOT_HAVE_SAVED` (`src/lib/tech/estimate-intents.ts`); `BUSINESS_BASE_LOCATION`.
- Produces (all pure, client-safe; consumed by Task 10b):
  - `form-fill-state.ts`: `InputValue`, `Inputs`, `Parsed`, `inputsFromValues`, `parseInput`, `nextLastValid`, `unparsedIds`, `buildChanges`, `afterLanded`, `mergeIntoInputs`, `carryForNewVersion`, `documentFromInputs`, `submitBlock`, `clearAllChanges`, `toggleSign`.
  - `form-save-machine.ts`: `DEBOUNCE_MS 1500`, `FLOOR_MS 3000`, `FIRST_RETRY_MS 3000`, `MAX_RETRY_MS 30000`, `KEEPALIVE_MAX_BYTES 61440`, `StopReason`, `SaveState`, `SAVE_IDLE`, `SaveEvent` (incl. `{ type: "submitted" }`), `nextSaveState`, `saveDue(state, now, dirty): "send_retry" | "send_new" | null`, `nextWakeAt`, `SubmitStep`, `submitStep(state, hasPendingDraft, flightOpen): "await_flight" | "resend_pending" | "send_submit"` (lead ruling 14).
  - `form-copy.ts`: `whenShort`, `dayShort`, `whenFull`, `READ_ONLY_COPY`, `ASSIGN_AGAIN`, `readOnlyCopy`, `StatusPhase`, `StatusInput`, `statusLine`, `SIGNED_OUT`, `TOO_LONG`, `COULDNT_SAVE`, `RETRYING`, `firstName`, `numberNote`, `formChips`, `cardVisit`, `backHref`, `fillHref`, `reminderVisible`, `missingRequiredLine`, `SUBMITTED_BY_OTHER`, `FOREIGN_CHANGE`, `SUBMITTED_ON`.

- [ ] **Step 1: Write the failing tests** — `src/lib/tech/form-fill-state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { FormField } from "@/lib/forms/form-schema";
import {
  afterLanded, buildChanges, carryForNewVersion, clearAllChanges, documentFromInputs, inputsFromValues, mergeIntoInputs, nextLastValid,
  parseInput, submitBlock, toggleSign, unparsedIds,
} from "./form-fill-state";

const TICK: FormField = { id: "f_0000000001", type: "checkbox", label: "Filter", required: true };
const NUM: FormField = { id: "f_0000000002", type: "number", label: "Suction", required: true, unit: "psi" };
const TEXT: FormField = { id: "f_0000000003", type: "short_text", label: "Size", required: false };
const YN: FormField = { id: "f_0000000004", type: "yes_no", label: "Clean?", required: false, allowNa: true };
const FIELDS = [TICK, NUM, TEXT, YN];

describe("inputs ↔ values", () => {
  it("round-trips each type; parseInput strips controls and reads empty as null", () => {
    const inputs = inputsFromValues(FIELDS, { [TICK.id]: true, [NUM.id]: 118, [YN.id]: "na" });
    expect(inputs).toEqual({ [TICK.id]: true, [NUM.id]: "118", [TEXT.id]: "", [YN.id]: "na" });
    expect(parseInput(TEXT, "a\u0007b")).toEqual({ kind: "value", value: "ab" });
    expect(parseInput(NUM, "12.")).toEqual({ kind: "unparsed" });
    expect(parseInput(NUM, "")).toEqual({ kind: "value", value: null });
    expect(documentFromInputs(FIELDS, inputs, {})).toEqual({ [TICK.id]: true, [NUM.id]: 118, [YN.id]: "na" });
  });
});

describe("the changes builder (spec §7.3)", () => {
  it('"12" landed, then "12." → the body still sends 12, never a deletion', () => {
    let lastValid = nextLastValid({}, NUM, "12");
    lastValid = nextLastValid(lastValid, NUM, "12.");
    expect(buildChanges(FIELDS, { [NUM.id]: "12." }, new Set([NUM.id]), lastValid)).toEqual({ [NUM.id]: 12 });
    expect(unparsedIds(FIELDS, { [NUM.id]: "12." })).toEqual([NUM.id]);
  });
  it("emptied → null; a never-valid partial is not sent; untouched fields are not sent", () => {
    expect(buildChanges(FIELDS, { [TEXT.id]: "", [NUM.id]: "-" }, new Set([TEXT.id, NUM.id]), {})).toEqual({ [TEXT.id]: null });
    expect(buildChanges(FIELDS, { [TICK.id]: true }, new Set(), {})).toEqual({});
  });
  it("an edit during the flight survives the landing", () => {
    const sent = { [TEXT.id]: "16x25" };
    const now = { [TEXT.id]: "16x25x1", [TICK.id]: true };
    const r = afterLanded(FIELDS, {}, sent, now, new Set([TEXT.id, TICK.id]));
    expect(r.base).toEqual({ [TEXT.id]: "16x25" });
    expect([...r.touched].sort()).toEqual([TEXT.id, TICK.id].sort());
    const done = afterLanded(FIELDS, {}, sent, { [TEXT.id]: "16x25" }, new Set([TEXT.id]));
    expect([...done.touched]).toEqual([]);
  });
  it("a tick whose response was lost, then an untick: the second body clears it", () => {
    const touched = new Set([TICK.id]);
    expect(buildChanges(FIELDS, { [TICK.id]: true }, touched, {})).toEqual({ [TICK.id]: true });
    expect(buildChanges(FIELDS, { [TICK.id]: false }, touched, {})).toEqual({ [TICK.id]: null });
  });
});

describe("merge and carry", () => {
  it("untouched inputs follow theirs; touched keep mine; banner only for a foreign change", () => {
    const r = mergeIntoInputs(FIELDS, {}, { [TEXT.id]: "mine" }, { [TICK.id]: true, [TEXT.id]: "theirs" }, { [TEXT.id]: "mine", [TICK.id]: false }, new Set([TEXT.id]));
    expect(r.inputs[TICK.id]).toBe(true);
    expect(r.inputs[TEXT.id]).toBe("mine");
    expect(r.foreignChange).toBe(true);
  });
  it("carry drops answers that no longer fit and lists them", () => {
    const v2: FormField[] = [TICK, { ...YN, allowNa: false }];
    expect(carryForNewVersion(v2, { [NUM.id]: 5 }, { [YN.id]: "na", [TICK.id]: true, [TEXT.id]: null })).toEqual({
      base: {}, mine: { [TICK.id]: true }, dropped: [YN.id, TEXT.id],
    });
  });
});

describe("submit checks", () => {
  it("unparsed numbers first, then missing required", () => {
    expect(submitBlock(FIELDS, { [NUM.id]: "1," })).toEqual({ kind: "unparsed", fieldIds: [NUM.id] });
    expect(submitBlock(FIELDS, { [NUM.id]: "300" })).toEqual({ kind: "missing", fieldIds: [TICK.id] });
    expect(submitBlock(FIELDS, { [NUM.id]: "300", [TICK.id]: true })).toBeNull();
  });
  it("Clear answers sends every answered field as null", () => {
    expect(clearAllChanges({ [TICK.id]: true, [NUM.id]: 5 })).toEqual({ [TICK.id]: null, [NUM.id]: null });
  });
});

describe("toggleSign", () => {
  it("empty → '-', toggles a leading minus", () => {
    expect(toggleSign("")).toBe("-");
    expect(toggleSign("12")).toBe("-12");
    expect(toggleSign("-12")).toBe("12");
  });
});
```

`src/lib/tech/form-save-machine.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextSaveState, nextWakeAt, saveDue, SAVE_IDLE, submitStep, type SaveEvent, type SaveState } from "./form-save-machine";

const run = (events: SaveEvent[], s: SaveState = SAVE_IDLE) => events.reduce(nextSaveState, s);

describe("nextSaveState / saveDue (spec §7.3)", () => {
  it("debounce: a save starts 1.5 s after the last change", () => {
    const s = run([{ type: "edit", now: 0 }, { type: "edit", now: 1000 }]);
    expect(saveDue(s, 2000, true)).toBeNull();
    expect(saveDue(s, 2500, true)).toBe("send_new");
    expect(nextWakeAt(s, true)).toBe(2500);
  });
  it("one write in flight; then at most one PUT per 3 s", () => {
    let s = run([{ type: "edit", now: 0 }, { type: "sent", now: 1500 }, { type: "edit", now: 1600 }]);
    expect(saveDue(s, 3200, true)).toBeNull();
    s = nextSaveState(s, { type: "landed" });
    expect(saveDue(s, 3200, true)).toBeNull();
    expect(saveDue(s, 4500, true)).toBe("send_new");
  });
  it("blur / hidden / pagehide bypass the floor but keep one in flight", () => {
    let s = run([{ type: "sent", now: 0 }, { type: "landed" }, { type: "edit", now: 100 }, { type: "flush" }]);
    expect(saveDue(s, 200, true)).toBe("send_new");
    s = run([{ type: "sent", now: 0 }, { type: "edit", now: 100 }, { type: "flush" }]);
    expect(saveDue(s, 200, true)).toBeNull();
  });
  it("an unknown result is re-sent first, after 3 s, doubling to 30 s; a new edit doesn't reset the wait", () => {
    let s = run([{ type: "sent", now: 0 }, { type: "unknown", now: 100, retryAfterMs: null }]);
    expect(s.waitUntil).toBe(3100);
    s = nextSaveState(s, { type: "edit", now: 200 });
    expect(saveDue(s, 3000, true)).toBeNull();
    expect(saveDue(s, 3100, true)).toBe("send_retry");
    const waits: number[] = [];
    s = SAVE_IDLE;
    for (let i = 0; i < 6; i++) {
      s = run([{ type: "sent", now: 0 }, { type: "unknown", now: 0, retryAfterMs: null }], s);
      waits.push(s.waitUntil);
    }
    expect(waits).toEqual([3000, 6000, 12000, 24000, 30000, 30000]);
    expect(run([{ type: "sent", now: 0 }, { type: "unknown", now: 0, retryAfterMs: 7000 }]).waitUntil).toBe(7000);
    expect(nextSaveState(s, { type: "landed" })).toMatchObject({ backoffMs: 0, retryPending: false });
  });
  it("401 stops; a values-size 400 stops until the next edit; another 400 waits for Try again", () => {
    expect(saveDue(run([{ type: "stop", reason: "signed_out" }, { type: "edit", now: 0 }]), 5000, true)).toBeNull();
    const big = run([{ type: "stop", reason: "too_large" }, { type: "edit", now: 0 }]);
    expect(big.stop).toBeNull();
    expect(saveDue(big, 5000, true)).toBe("send_new");
    const bad = run([{ type: "stop", reason: "bad_request" }, { type: "edit", now: 0 }]);
    expect(saveDue(bad, 5000, true)).toBeNull();
    expect(saveDue(nextSaveState(bad, { type: "try_again" }), 5000, true)).toBe("send_retry");
  });
  it("a submit sent or unknown locks the page and pauses autosave", () => {
    const s = run([{ type: "edit", now: 0 }, { type: "lock" }]);
    expect(saveDue(s, 9000, true)).toBeNull();
    expect(nextWakeAt(s, true)).toBeNull();
    expect(saveDue(nextSaveState(s, { type: "unlock" }), 9000, true)).toBe("send_new");
  });
  it("submit waits for the write in flight, then re-sends a pending unknown draft, then submits", () => {
    expect(submitStep(run([{ type: "sent", now: 0 }]), true, true)).toBe("await_flight");
    const unknown = run([{ type: "sent", now: 0 }, { type: "unknown", now: 10, retryAfterMs: null }, { type: "lock" }]);
    // Locked by the submit and still inside the back-off: the draft goes first anyway.
    expect(submitStep(unknown, true, false)).toBe("resend_pending");
    expect(submitStep(nextSaveState(unknown, { type: "landed" }), false, false)).toBe("send_submit");
  });
  it("a draft queued behind a successful submit is cleared, never retried", () => {
    const s = run([{ type: "sent", now: 0 }, { type: "unknown", now: 10, retryAfterMs: null }, { type: "edit", now: 20 }, { type: "submitted" }]);
    expect(s.retryPending).toBe(false);
    expect(saveDue(s, 60_000, true)).toBeNull();
    expect(nextWakeAt(s, true)).toBeNull();
    expect(saveDue(nextSaveState(s, { type: "edit", now: 70_000 }), 80_000, true)).toBeNull();
  });
  it("nothing dirty, nothing sent", () => {
    expect(saveDue(run([{ type: "edit", now: 0 }]), 5000, false)).toBeNull();
  });
});
```

`src/lib/tech/form-copy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  ASSIGN_AGAIN, backHref, cardVisit, dayShort, firstName, SUBMITTED_ON, formChips, numberNote, readOnlyCopy, READ_ONLY_COPY, reminderVisible, statusLine,
  type StatusInput,
} from "./form-copy";
import type { CardForm } from "./form-view";

const TZ = "America/New_York";
const NOW = new Date("2026-11-07T19:45:00.000Z"); // 2:45 PM Eastern
const base: StatusInput = { phase: "saved", savedAt: "2026-11-07T19:41:00.000Z", savedByOther: null, unparsedCount: 0, submittedAt: null, submittedByName: null, now: NOW };

describe("statusLine (spec §7.3 table)", () => {
  it("saved today, earlier, and by someone else", () => {
    expect(statusLine(base, TZ)).toBe("Saved · 2:41 PM");
    expect(statusLine({ ...base, savedAt: "2026-11-06T19:41:00.000Z" }, TZ)).toBe("Saved · Nov 6, 2:41 PM");
    expect(statusLine({ ...base, savedByOther: "Sam" }, TZ)).toBe("Saved · 2:41 PM · Sam");
  });
  it("the day is the business timezone's: 11:30 PM Eastern is still today though UTC is tomorrow", () => {
    const late = new Date("2026-11-08T04:45:00.000Z"); // 11:45 PM Eastern, Nov 7
    expect(statusLine({ ...base, savedAt: "2026-11-08T04:30:00.000Z", now: late }, TZ)).toBe("Saved · 11:30 PM");
    expect(statusLine({ ...base, savedAt: "2026-11-07T04:30:00.000Z", now: late }, TZ)).toBe("Saved · Nov 6, 11:30 PM");
  });
  it("never Saved while a number is unparsed", () => {
    expect(statusLine({ ...base, unparsedCount: 1 }, TZ)).toBe("Not saved yet: 1 answer isn't a number.");
    expect(statusLine({ ...base, phase: "saving", unparsedCount: 2 }, TZ)).toBe("Not saved yet: 2 answers aren't numbers.");
  });
  it("the other phases", () => {
    expect(statusLine({ ...base, phase: "blank", savedAt: null }, TZ)).toBe("");
    expect(statusLine({ ...base, phase: "saving" }, TZ)).toBe("Saving…");
    expect(statusLine({ ...base, phase: "retrying" }, TZ)).toBe("Not saved yet. Retrying…");
    expect(statusLine({ ...base, phase: "signed_out" }, TZ)).toBe("You've been signed out. Sign in again, then open this job again.");
    expect(statusLine({ ...base, phase: "too_large" }, TZ)).toBe("This form is too long to save. Shorten the longest answers.");
    expect(statusLine({ ...base, phase: "bad_request" }, TZ)).toBe("Couldn't save your answers.");
    expect(statusLine({ ...base, phase: "submit_sent" }, TZ)).toBe("Submitting…");
    expect(statusLine({ ...base, phase: "submit_unknown" }, TZ)).toBe("Your last change may not have saved. Try again.");
    expect(statusLine({ ...base, phase: "submitted", submittedAt: "2026-11-07T19:41:00.000Z", submittedByName: "Alex Rivera" }, TZ)).toBe("Submitted · Nov 7, 2:41 PM · Alex Rivera");
  });
});

describe("readOnlyCopy", () => {
  it("every reason has its line; submitted is the status line only", () => {
    for (const [reason, copy] of Object.entries(READ_ONLY_COPY)) {
      expect(readOnlyCopy(reason as keyof typeof READ_ONLY_COPY, { myRowCancelled: false })).toEqual([copy]);
    }
    expect(readOnlyCopy("submitted", { myRowCancelled: false })).toEqual([]);
    expect(readOnlyCopy(null, { myRowCancelled: false })).toEqual([]);
  });
  it("not_assigned with my own row cancelled adds the reassign line", () => {
    expect(readOnlyCopy("not_assigned", { myRowCancelled: true })).toEqual([READ_ONLY_COPY.not_assigned, ASSIGN_AGAIN]);
  });
});

describe("formChips precedence (spec §7.2)", () => {
  const card = (over: Partial<CardForm> = {}): CardForm => ({ formId: "f", name: "M", description: null, required: true, submission: null, submittedOn: null, ...over });
  const sub = (over: Partial<NonNullable<CardForm["submission"]>> = {}) => ({
    id: "s", status: "draft" as const, revision: 1, hasAnswers: true, erased: false, updatedAt: "x", submittedAt: null, submittedByName: null, ...over,
  });
  it("erased, submitted here, submitted on another visit, draft, not started", () => {
    expect(formChips(card({ submission: sub({ erased: true, status: "submitted" }) })).status).toBe("Answers removed");
    expect(formChips(card({ submission: sub({ status: "submitted" }) })).status).toBe("Submitted");
    expect(formChips(card({ submission: sub(), submittedOn: { appointmentId: "a", appointmentNumber: 1, submittedAt: "x" } })).status).toBe("Submitted on visit #1");
    expect(formChips(card({ submission: sub() }))).toEqual({ status: "Draft", required: true });
    expect(formChips(card({ submission: sub({ hasAnswers: false }) })).status).toBe("Not started");
    expect(formChips(card()).status).toBe("Not started");
  });
});

describe("navigation and reminders", () => {
  it("cardVisit: ?visit=, then my assignment, then the active visit", () => {
    expect(cardVisit("p", "a", "b")).toBe("p");
    expect(cardVisit(undefined, null, "b")).toBe("b");
    expect(cardVisit(undefined, null, null)).toBeNull();
  });
  it("backHref: ?visit only when it is my visit; from= returns to that visit's page", () => {
    expect(backHref({ jobId: "j", formId: "f", visitId: "v", myVisit: true, from: null })).toEqual({ label: "Back to job", href: "/tech/jobs/j?visit=v" });
    expect(backHref({ jobId: "j", formId: "f", visitId: "v", myVisit: false, from: null })).toEqual({ label: "Back to job", href: "/tech/jobs/j" });
    expect(backHref({ jobId: "j", formId: "f", visitId: "v1", myVisit: false, from: "v2" })).toEqual({ label: "Back", href: "/tech/jobs/j/forms/f?visit=v2" });
  });
  it("reminderVisible: close out on a native job with reminders, blocked or ready", () => {
    expect(reminderVisible("close_out", true, [1])).toBe(true);
    expect(reminderVisible("completed", true, [1])).toBe(false);
    expect(reminderVisible("close_out", false, [1])).toBe(false);
    expect(reminderVisible("close_out", true, [])).toBe(false);
  });
  it("the submitted-on line names the day even for a submission earlier today", () => {
    expect(SUBMITTED_ON(1, dayShort("2026-11-07T14:00:00.000Z", TZ))).toBe("Submitted on visit #1 · Nov 7. Fill it in again only if this visit needs it.");
  });
  it("number notes and first names", () => {
    expect(numberNote("partial")).toBe("Not saved yet. Finish the number.");
    expect(numberNote("invalid")).toBe("Enter a number like 12.5 (up to 3 decimal places).");
    expect(numberNote("out_of_bounds")).toBe("Enter a number under 1,000,000.");
    expect(numberNote("value")).toBeNull();
    expect(firstName("Sam  Lee")).toBe("Sam");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/tech/form-fill-state.test.ts src/lib/tech/form-save-machine.test.ts src/lib/tech/form-copy.test.ts`
Expected: FAIL — the three modules are unresolved.

- [ ] **Step 3: Implement.** `src/lib/tech/form-fill-state.ts`:

```ts
/**
 * The fill page's answer bookkeeping (M3d spec §7.3): what each input holds,
 * which fields are touched, the `changes` body of the next PUT, what a landed
 * PUT does to `base` and `touched`, merges, and the submit checks. Pure.
 */
import type { FormField } from "@/lib/forms/form-schema";
import {
  applyChanges, carryValues, mergeDraft, missingRequired, numberInputState, stripControlChars,
  type Changes, type FieldValue, type FormValues,
} from "@/lib/forms/form-values";

/** checkbox: boolean; texts and numbers: the raw text; yes / no and choice: the picked value or null. */
export type InputValue = boolean | string | null;
export type Inputs = Readonly<Record<string, InputValue>>;
export type Parsed = { readonly kind: "value"; readonly value: FieldValue | null } | { readonly kind: "unparsed" };

export function inputsFromValues(fields: readonly FormField[], values: FormValues): Inputs {
  const out: Record<string, InputValue> = {};
  for (const f of fields) {
    const v = values[f.id];
    switch (f.type) {
      case "heading":
        break;
      case "checkbox":
        out[f.id] = v === true;
        break;
      case "number":
        out[f.id] = typeof v === "number" ? String(v) : "";
        break;
      case "short_text":
      case "long_text":
        out[f.id] = typeof v === "string" ? v : "";
        break;
      default:
        out[f.id] = typeof v === "string" ? v : null;
    }
  }
  return out;
}

/** What an input means right now; `null` value = empty (a cleared answer). */
export function parseInput(field: FormField, raw: InputValue | undefined): Parsed {
  switch (field.type) {
    case "heading":
      return { kind: "value", value: null };
    case "checkbox":
      return { kind: "value", value: raw === true ? true : null };
    case "yes_no":
    case "choice":
      return { kind: "value", value: typeof raw === "string" && raw !== "" ? raw : null };
    case "short_text":
    case "long_text": {
      const s = typeof raw === "string" ? stripControlChars(raw) : "";
      return { kind: "value", value: s === "" ? null : s };
    }
    case "number": {
      const st = numberInputState(typeof raw === "string" ? raw : "");
      if (st.kind === "empty") return { kind: "value", value: null };
      return st.kind === "value" ? { kind: "value", value: st.value } : { kind: "unparsed" };
    }
  }
}

/** Number fields remember their last valid value: a half-typed number never deletes the saved one. */
export function nextLastValid(lastValid: Readonly<Record<string, number>>, field: FormField, raw: InputValue): Record<string, number> {
  if (field.type !== "number") return { ...lastValid };
  const p = parseInput(field, raw);
  if (p.kind === "value" && typeof p.value === "number") return { ...lastValid, [field.id]: p.value };
  return { ...lastValid };
}

/** Numbers that aren't a value right now (partial, invalid or out of bounds). */
export function unparsedIds(fields: readonly FormField[], inputs: Inputs): string[] {
  return fields.filter((f) => f.type === "number" && parseInput(f, inputs[f.id]).kind === "unparsed").map((f) => f.id);
}

/**
 * The next PUT's `changes`: every touched field's parsed value, null when
 * emptied; an unparsed number sends its last valid value, or nothing if it
 * never had one.
 */
export function buildChanges(
  fields: readonly FormField[], inputs: Inputs, touched: ReadonlySet<string>, lastValid: Readonly<Record<string, number>>,
): Changes {
  const out: Record<string, FieldValue | null> = {};
  for (const f of fields) {
    if (f.type === "heading" || !touched.has(f.id)) continue;
    const p = parseInput(f, inputs[f.id]);
    if (p.kind === "value") out[f.id] = p.value;
    else if (f.id in lastValid) out[f.id] = lastValid[f.id]!;
  }
  return out;
}

/**
 * A PUT landed: `base` advances by that body, and a field leaves `touched`
 * only if what it holds now equals what the landed body sent (an edit made
 * during the flight stays touched and goes in the next PUT).
 */
export function afterLanded(
  fields: readonly FormField[], base: FormValues, landed: Changes, inputs: Inputs, touched: ReadonlySet<string>,
): { base: FormValues; touched: Set<string> } {
  const applied = applyChanges(fields, base, landed);
  const nextBase = applied.ok ? applied.values : base;
  const byId = new Map(fields.map((f) => [f.id, f]));
  const next = new Set(touched);
  for (const [id, sent] of Object.entries(landed)) {
    const f = byId.get(id);
    if (!f) continue;
    const now = parseInput(f, inputs[id]);
    if (now.kind === "value" && now.value === sent) next.delete(id);
  }
  return { base: nextBase, touched: next };
}

/** Merge a re-read row under my touched fields; untouched inputs follow the merged values. */
export function mergeIntoInputs(
  fields: readonly FormField[], base: FormValues, mine: Changes, theirs: FormValues, inputs: Inputs, touched: ReadonlySet<string>,
): { inputs: Inputs; base: FormValues; foreignChange: boolean } {
  const m = mergeDraft(base, mine, theirs);
  const fresh = inputsFromValues(fields, m.values);
  const out: Record<string, InputValue> = { ...fresh };
  for (const id of touched) if (id in inputs) out[id] = inputs[id]!;
  return { inputs: out, base: theirs, foreignChange: m.foreignChange };
}

/** FORM_CHANGED: carry base and mine to the new fields (spec §4.4); `dropped` = answers that no longer fit. */
export function carryForNewVersion(fields: readonly FormField[], base: FormValues, mine: Changes): { base: FormValues; mine: Changes; dropped: string[] } {
  const keptMine: Record<string, FieldValue | null> = {};
  const dropped: string[] = [];
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const [id, v] of Object.entries(mine)) {
    if (byId.has(id) && byId.get(id)!.type !== "heading" && (v === null || carryValues(fields, { [id]: v })[id] !== undefined)) keptMine[id] = v;
    else dropped.push(id);
  }
  return { base: carryValues(fields, base), mine: keptMine, dropped };
}

/** The full document the inputs describe (for submit). */
export function documentFromInputs(fields: readonly FormField[], inputs: Inputs, lastValid: Readonly<Record<string, number>>): FormValues {
  const out: Record<string, FieldValue> = {};
  for (const f of fields) {
    const p = parseInput(f, inputs[f.id]);
    if (p.kind === "value" && p.value !== null) out[f.id] = p.value;
    else if (p.kind === "unparsed" && f.id in lastValid) out[f.id] = lastValid[f.id]!;
  }
  return out;
}

export type SubmitBlock = { readonly kind: "unparsed"; readonly fieldIds: string[] } | { readonly kind: "missing"; readonly fieldIds: string[] } | null;

/** Submit is refused on the client while a number isn't a value, or required answers are missing. */
export function submitBlock(fields: readonly FormField[], inputs: Inputs): SubmitBlock {
  const unparsed = unparsedIds(fields, inputs);
  if (unparsed.length > 0) return { kind: "unparsed", fieldIds: unparsed };
  const missing = missingRequired(fields, documentFromInputs(fields, inputs, {}));
  return missing.length > 0 ? { kind: "missing", fieldIds: missing } : null;
}

/** `Clear answers`: every answered field sent as null. */
export function clearAllChanges(base: FormValues): Changes {
  return Object.fromEntries(Object.keys(base).map((id) => [id, null]));
}

/** `±` toggles a leading minus (the iOS decimal pad has none); empty becomes "-". */
export function toggleSign(raw: string): string {
  if (raw === "") return "-";
  return raw.startsWith("-") ? raw.slice(1) : `-${raw}`;
}
```

`src/lib/tech/form-save-machine.ts`:

```ts
/**
 * Autosave timing (M3d spec §7.3), pure. A save starts 1.5 s after the last
 * change, on blur of a text field, and on hidden / pagehide (those bypass the
 * 3 s floor but keep one write in flight and any back-off). One write in
 * flight; an unknown result is re-sent with its own body and saveId before any
 * newer write; retries wait Retry-After or 3 s, doubling to 30 s, and a new
 * edit doesn't reset the wait.
 */
export const DEBOUNCE_MS = 1500;
export const FLOOR_MS = 3000;
export const FIRST_RETRY_MS = 3000;
export const MAX_RETRY_MS = 30_000;

export type StopReason = "signed_out" | "too_large" | "bad_request" | "blocked";

export interface SaveState {
  readonly inFlight: boolean;
  /** An unknown write waits to be re-sent (the caller keeps its body and saveId). */
  readonly retryPending: boolean;
  readonly dueAt: number | null;
  readonly immediate: boolean;
  readonly lastSentAt: number | null;
  readonly backoffMs: number;
  readonly waitUntil: number;
  readonly stop: StopReason | null;
  /** A submit is `sent` or `unknown`: the page is locked and autosave paused. */
  readonly locked: boolean;
}

export const SAVE_IDLE: SaveState = {
  inFlight: false, retryPending: false, dueAt: null, immediate: false, lastSentAt: null,
  backoffMs: 0, waitUntil: 0, stop: null, locked: false,
};

export type SaveEvent =
  | { readonly type: "edit"; readonly now: number }
  | { readonly type: "flush" }
  | { readonly type: "sent"; readonly now: number }
  | { readonly type: "landed" }
  | { readonly type: "unknown"; readonly now: number; readonly retryAfterMs: number | null }
  | { readonly type: "stop"; readonly reason: StopReason }
  | { readonly type: "try_again" }
  | { readonly type: "resume" }
  | { readonly type: "lock" }
  | { readonly type: "unlock" }
  /** The form was submitted (by this page or anyone): nothing more is saved. */
  | { readonly type: "submitted" };

export function nextSaveState(s: SaveState, e: SaveEvent): SaveState {
  switch (e.type) {
    case "edit":
      // A too-large stop lifts on the next edit; a bad-request stop waits for Try again.
      return { ...s, dueAt: e.now + DEBOUNCE_MS, stop: s.stop === "too_large" ? null : s.stop };
    case "flush":
      return { ...s, immediate: true };
    case "sent":
      return { ...s, inFlight: true, retryPending: false, lastSentAt: e.now, dueAt: null, immediate: false };
    case "landed":
      return { ...s, inFlight: false, retryPending: false, backoffMs: 0, waitUntil: 0 };
    case "unknown": {
      const backoffMs = s.backoffMs === 0 ? FIRST_RETRY_MS : Math.min(s.backoffMs * 2, MAX_RETRY_MS);
      return { ...s, inFlight: false, retryPending: true, backoffMs, waitUntil: e.now + (e.retryAfterMs ?? backoffMs) };
    }
    case "stop":
      return { ...s, inFlight: false, retryPending: false, stop: e.reason, dueAt: null, immediate: false };
    case "try_again":
      // `Couldn't save your answers.` + Try again: the same body and saveId go again now.
      return s.stop === "bad_request" ? { ...s, stop: null, retryPending: true, waitUntil: 0 } : s;
    case "resume":
      return { ...s, stop: null };
    case "lock":
      return { ...s, locked: true };
    case "unlock":
      return { ...s, locked: false };
    case "submitted":
      return { ...s, inFlight: false, retryPending: false, dueAt: null, immediate: false, stop: "blocked" };
  }
}

export type SubmitStep = "await_flight" | "resend_pending" | "send_submit";

/**
 * What a confirmed Submit does next (spec §4.2 / §7.3: an unknown result is
 * retried with its own body and saveId before any newer write — the submit
 * included): wait for the write in flight, then re-send a pending draft, then
 * submit.
 */
export function submitStep(s: SaveState, hasPendingDraft: boolean, flightOpen: boolean): SubmitStep {
  if (s.inFlight || flightOpen) return "await_flight";
  if (hasPendingDraft || s.retryPending) return "resend_pending";
  return "send_submit";
}

export type SaveAction = "send_retry" | "send_new" | null;

/** What to send now, if anything. `dirty` = there are changes to send. */
export function saveDue(s: SaveState, now: number, dirty: boolean): SaveAction {
  if (s.locked || s.stop !== null || s.inFlight) return null;
  if (s.retryPending) return now >= s.waitUntil ? "send_retry" : null;
  if (!dirty || now < s.waitUntil) return null;
  if (s.immediate) return "send_new";
  if (s.dueAt !== null && now >= s.dueAt && (s.lastSentAt === null || now - s.lastSentAt >= FLOOR_MS)) return "send_new";
  return null;
}

/** When to look again (a timer), or null when nothing is scheduled. */
export function nextWakeAt(s: SaveState, dirty: boolean): number | null {
  if (s.locked || s.stop !== null || s.inFlight) return null;
  if (s.retryPending) return s.waitUntil;
  if (!dirty) return null;
  if (s.immediate) return s.waitUntil;
  if (s.dueAt === null) return null;
  return Math.max(s.dueAt, s.lastSentAt === null ? 0 : s.lastSentAt + FLOOR_MS, s.waitUntil);
}

/** keepalive only for bodies of 60 KB or less (the browser's keepalive budget). */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;
```

`src/lib/tech/form-copy.ts`:

```ts
/** Technician form copy and small decisions (M3d spec §7.2–§7.4, §8). Pure, client-safe. */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import type { WriteBlockedReason } from "@/lib/forms/form-gates";
import { plural } from "@/lib/format/plural";
import { MAY_NOT_HAVE_SAVED } from "@/lib/tech/estimate-intents";
import type { CardForm } from "@/lib/tech/form-view";

const TZ = BUSINESS_BASE_LOCATION.timezone;

const dayKey = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const time = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(d);
const monthDay = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(d);

/** "2:41 PM" today, "Nov 6, 2:41 PM" earlier (business timezone). */
export function whenShort(iso: string, now: Date, timeZone: string = TZ): string {
  const d = new Date(iso);
  return dayKey(d, timeZone) === dayKey(now, timeZone) ? time(d, timeZone) : `${monthDay(d, timeZone)}, ${time(d, timeZone)}`;
}

export const READ_ONLY_COPY: Record<Exclude<WriteBlockedReason, "submitted">, string> = {
  not_assigned: "Only a technician on this visit can fill in its forms.",
  visit_ended: "This visit has ended.",
  not_on_site: "Arrive at the job first.",
  job_closed: "This job is closed.",
  archived: "This form was archived by the office.",
  answers_removed: "These answers were removed.",
  customer_removed: "This job's customer was removed.",
  unreadable: "These answers can't be shown.",
};
export const ASSIGN_AGAIN = "Ask the office to assign you to this job again.";

/** The read-only lines for a reason (`submitted` shows in the status line only). */
export function readOnlyCopy(reason: WriteBlockedReason | null, opts: { readonly myRowCancelled: boolean }): string[] {
  if (reason === null || reason === "submitted") return [];
  const lines = [READ_ONLY_COPY[reason]];
  if (reason === "not_assigned" && opts.myRowCancelled) lines.push(ASSIGN_AGAIN);
  return lines;
}

export type StatusPhase =
  | "blank" | "saved" | "saving" | "retrying" | "signed_out" | "too_large" | "bad_request" | "blocked"
  | "submit_sent" | "submit_unknown" | "submitted";

export interface StatusInput {
  readonly phase: StatusPhase;
  readonly savedAt: string | null;
  /** First name of whoever saved last, when it wasn't me. */
  readonly savedByOther: string | null;
  readonly unparsedCount: number;
  readonly submittedAt: string | null;
  readonly submittedByName: string | null;
  readonly now: Date;
}

export const SIGNED_OUT = "You've been signed out. Sign in again, then open this job again.";
export const TOO_LONG = "This form is too long to save. Shorten the longest answers.";
export const COULDNT_SAVE = "Couldn't save your answers.";
export const RETRYING = "Not saved yet. Retrying…";

/** The status line (spec §7.3 table). Never `Saved` while a number is unparsed. */
export function statusLine(i: StatusInput, timeZone: string = TZ): string {
  switch (i.phase) {
    case "submitted":
      return ["Submitted", i.submittedAt ? whenFull(i.submittedAt, timeZone) : null, i.submittedByName].filter(Boolean).join(" · ");
    case "submit_sent":
      return "Submitting…";
    case "submit_unknown":
      return MAY_NOT_HAVE_SAVED;
    case "signed_out":
      return SIGNED_OUT;
    case "too_large":
      return TOO_LONG;
    case "bad_request":
      return COULDNT_SAVE;
    case "blocked":
      return "";
    default:
      break;
  }
  if (i.unparsedCount > 0) {
    return `Not saved yet: ${plural(i.unparsedCount, "answer isn't a number.", "answers aren't numbers.")}`;
  }
  if (i.phase === "retrying") return RETRYING;
  if (i.phase === "saving") return "Saving…";
  if (i.phase === "saved" && i.savedAt) {
    const by = i.savedByOther ? ` · ${i.savedByOther}` : "";
    return `Saved · ${whenShort(i.savedAt, i.now, timeZone)}${by}`;
  }
  return "";
}

/** "Nov 6" (the "Submitted on visit #1 · Nov 6" line, whatever the time). */
export function dayShort(iso: string, timeZone: string = TZ): string {
  return monthDay(new Date(iso), timeZone);
}

/** "Nov 7, 2:41 PM" always (the submitted line). */
export function whenFull(iso: string, timeZone: string = TZ): string {
  const d = new Date(iso);
  return `${monthDay(d, timeZone)}, ${time(d, timeZone)}`;
}

export const firstName = (name: string | null): string | null => (name ? name.trim().split(/\s+/)[0] ?? null : null);

/** The number input's note under it (spec §7.3). */
export function numberNote(kind: "empty" | "partial" | "invalid" | "out_of_bounds" | "value"): string | null {
  if (kind === "partial") return "Not saved yet. Finish the number.";
  if (kind === "invalid") return "Enter a number like 12.5 (up to 3 decimal places).";
  if (kind === "out_of_bounds") return "Enter a number under 1,000,000.";
  return null;
}

/** The card's chips, in precedence (spec §7.2). */
export function formChips(f: CardForm): { readonly status: string; readonly required: boolean } {
  const s = f.submission;
  let status: string;
  if (s?.erased) status = "Answers removed";
  else if (s?.status === "submitted") status = "Submitted";
  else if (f.submittedOn) status = `Submitted on visit #${f.submittedOn.appointmentNumber}`;
  else status = s?.hasAnswers ? "Draft" : "Not started";
  return { status, required: f.required };
}

/** The card's visit: `?visit=`, else my assignment's visit, else the job's active visit. */
export function cardVisit(param: string | undefined, assignmentVisitId: string | null, activeVisitId: string | null): string | null {
  return param ?? assignmentVisitId ?? activeVisitId ?? null;
}

/** The fill page's back link (spec §7.3). */
export function backHref(p: { jobId: string; formId: string; visitId: string; myVisit: boolean; from: string | null }): { label: string; href: string } {
  if (p.from) return { label: "Back", href: `/tech/jobs/${p.jobId}/forms/${p.formId}?visit=${p.from}` };
  return { label: "Back to job", href: p.myVisit ? `/tech/jobs/${p.jobId}?visit=${p.visitId}` : `/tech/jobs/${p.jobId}` };
}

export const fillHref = (jobId: string, formId: string, visitId: string, from?: string): string =>
  `/tech/jobs/${jobId}/forms/${formId}?visit=${visitId}${from ? `&from=${from}` : ""}`;

/** The close-out sheet shows "Not submitted yet:" for close out on native jobs, blocked or ready (spec §7.4). */
export function reminderVisible(action: string | null, native: boolean, reminders: readonly unknown[]): boolean {
  return action === "close_out" && native && reminders.length > 0;
}

export const missingRequiredLine = (n: number): string =>
  n === 1 ? "1 required question isn't answered." : `${n} required questions aren't answered.`;

export const SUBMITTED_BY_OTHER = (name: string): string => `${name} submitted this form. Your last changes weren't saved.`;
export const FOREIGN_CHANGE = "Someone else changed this form. Their answers are shown, and yours are kept.";
export const SUBMITTED_ON = (n: number, day: string): string => `Submitted on visit #${n} · ${day}. Fill it in again only if this visit needs it.`;
```

- [ ] **Step 4: Run them to verify they pass**

Run: the Step 2 command. Expected: PASS (10 + 9 + 12).

- [ ] **Step 5: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/form-fill-state.ts src/lib/tech/form-fill-state.test.ts src/lib/tech/form-save-machine.ts src/lib/tech/form-save-machine.test.ts src/lib/tech/form-copy.ts src/lib/tech/form-copy.test.ts && npx vitest run
git add src/lib/tech/form-fill-state.ts src/lib/tech/form-fill-state.test.ts src/lib/tech/form-save-machine.ts src/lib/tech/form-save-machine.test.ts src/lib/tech/form-copy.ts src/lib/tech/form-copy.test.ts
git commit -m "$(cat <<'EOF'
feat(m3d): fill-page pure modules (touched/changes bookkeeping, autosave and submit ordering, status and read-only copy)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 10b: Technician fill — Forms card, fill page with autosave and keyed submit, close-out reminder

**Files:**
- Create: `src/components/tech/forms/forms-card.tsx`, `src/components/tech/forms/form-field-input.tsx`, `src/components/tech/forms/form-fill-client.tsx`, `src/app/tech/jobs/[id]/forms/[formId]/page.tsx`
- Modify: `src/lib/tech/field-queries.ts` (`activeVisitId` on the summary), `src/components/tech/tech-job-summary.tsx`, `src/components/tech/close-out-sheet.tsx`, `src/components/tech/tech-job-detail-client.tsx`

**Interfaces:**
- Consumes: Task 10a (all of it); Task 7 `TechFormsView`, `TechFormView`, `unsubmittedRequired`; Task 8 routes; `useIdempotencyKey` (`src/hooks/use-idempotency-key.ts`, `storageKey` + `rehydrate`), `ESTIMATE_INTENTS_KEY` (`src/lib/tech/estimate-intents.ts`), `classifyWriteError` (`src/lib/tech/invoice-client-errors.ts`), `outcomeEvent` (`src/lib/tech/invoice-key-state.ts`), `postJson` (`src/components/tech/invoice/post-json.ts`), `mintKey`; `pickActiveVisit` (already computed in `getTechJobSummary`).
- Produces: `TechJobSummary.activeVisitId`; `SummaryLoaded` gains `native`, `assignmentVisitId`, `activeVisitId`; `TechJobSummary` prop `formReminders`; `FormsCard` prop `summaryFailed` (a failed summary shows "Couldn't load forms.", never a skeleton forever); `CloseOutSheet` prop `reminders` (rendered under the blockers when blocked, between the warnings and the confirm when ready; never blocks); `FormsCard({ jobId, visitId: string | null | undefined, refreshKey, onLoaded })` (undefined = the summary hasn't loaded: a skeleton); `FormFillClient` keyed by form, visit and `from` with a keyed recovery ref (lead ruling 11); the submit intent id `form:submit:<formId>:<appointmentId>` in `ESTIMATE_INTENTS_KEY(rid)` storing `{ path, payload, base }` (`recoverEstimateIntents` callers match other prefixes, so they never pick it up).

- [ ] **Step 1: The summary's active visit.** `src/lib/tech/field-queries.ts`:

```diff
diff --git a/src/lib/tech/field-queries.ts b/src/lib/tech/field-queries.ts
index 1e31434..a382bad 100644
--- a/src/lib/tech/field-queries.ts
+++ b/src/lib/tech/field-queries.ts
@@ -69,6 +69,8 @@ export interface TechJobSummary {
   readonly accessNotes: string | null;
   /** The caller's row this summary is about (null for a legacy assigned_to-only reader). */
   readonly assignment: TechAssignmentRow | null;
+  /** M3d: the visit the request is "on" (pickActiveVisit), for readers without a row (the Forms card). */
+  readonly activeVisitId: string | null;
   readonly allowedActions: readonly TechAction[];
   readonly blockers: readonly Blocker[];
   readonly native: boolean;
@@ -189,6 +191,7 @@ export async function getTechJobSummary(
     address: safeDecrypt(row.addressEncrypted),
     accessNotes: row.accessNotes,
     assignment,
+    activeVisitId,
     allowedActions: actions,
     blockers,
     native,
```

`src/components/tech/tech-job-summary.tsx`:

```diff
diff --git a/src/components/tech/tech-job-summary.tsx b/src/components/tech/tech-job-summary.tsx
index 9b6c7d6..a1ee530 100644
--- a/src/components/tech/tech-job-summary.tsx
+++ b/src/components/tech/tech-job-summary.tsx
@@ -37,6 +37,7 @@ interface TechJobSummary {
   readonly address: string | null;
   readonly accessNotes: string | null;
   readonly assignment: { readonly appointmentId: string; readonly isLead: boolean } | null;
+  readonly activeVisitId: string | null;
   readonly allowedActions: readonly TechAction[];
   readonly blockers: readonly Blocker[];
   readonly native: boolean;
@@ -69,12 +70,17 @@ function directionsUrl(address: string): string {
 export interface SummaryLoaded {
   readonly status: string;
   readonly invoiceState: string | null;
+  /** M3d: the Forms card's visit pick and the close-out reminder. */
+  readonly native: boolean;
+  readonly assignmentVisitId: string | null;
+  readonly activeVisitId: string | null;
 }
 
 export function TechJobSummary({
   id,
   appointmentId,
   unbilledParts = 0,
+  formReminders = [],
   onStatusChanged,
   onLoaded,
 }: {
@@ -82,6 +88,8 @@ export function TechJobSummary({
   readonly appointmentId?: string;
   /** Parts on no non-void invoice, for the Close out heads-up. */
   readonly unbilledParts?: number;
+  /** M3d: required forms with no submitted copy (the close-out reminder links). */
+  readonly formReminders?: ReadonlyArray<{ readonly name: string; readonly href: string }>;
   readonly onStatusChanged?: () => void;
   /** Called after each summary load; 'not_found' lets the page drop every form. */
   readonly onLoaded?: (outcome: JobLoadOutcome, job: SummaryLoaded | null) => void;
@@ -114,7 +122,13 @@ export function TechJobSummary({
       onLoaded?.(
         outcome,
         outcome === 'ok'
-          ? { status: String(body.data.status), invoiceState: body.data.invoiceSummary?.state ?? null }
+          ? {
+              status: String(body.data.status),
+              invoiceState: body.data.invoiceSummary?.state ?? null,
+              native: body.data.native === true,
+              assignmentVisitId: body.data.assignment?.appointmentId ?? null,
+              activeVisitId: body.data.activeVisitId ?? null,
+            }
           : null,
       );
     } catch {
@@ -326,6 +340,7 @@ export function TechJobSummary({
           blockers={relevantBlockers(serverBlockers ?? job.blockers)}
           invoice={job.invoiceSummary}
           unbilledParts={unbilledParts}
+          reminders={job.native ? formReminders : []}
           pending={advancing !== null}
           error={sheetError}
           onConfirm={(a, options) => void advance(a, options)}
```

`src/components/tech/close-out-sheet.tsx` (the reminder; blockers, the close-out route and `status-writes.ts` are unchanged):

```diff
diff --git a/src/components/tech/close-out-sheet.tsx b/src/components/tech/close-out-sheet.tsx
index f3d7103..d1ae3aa 100644
--- a/src/components/tech/close-out-sheet.tsx
+++ b/src/components/tech/close-out-sheet.tsx
@@ -1,6 +1,7 @@
 'use client';
 
 import { useState } from 'react';
+import Link from 'next/link';
 import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
 import { Button } from '@/components/ui/button';
 import { HOLD_REASONS, type HoldReason } from '@/lib/admin/request-status';
@@ -15,6 +16,7 @@ import {
   type CloseOutInvoice,
   type SheetAction,
 } from '@/components/tech/tech-status-confirm';
+import { reminderVisible } from '@/lib/tech/form-copy';
 
 export interface SheetConfirmOptions {
   readonly holdReason?: HoldReason;
@@ -41,6 +43,7 @@ export function CloseOutSheet({
   blockers,
   invoice = null,
   unbilledParts = 0,
+  reminders = [],
   pending,
   error,
   onConfirm,
@@ -52,6 +55,8 @@ export function CloseOutSheet({
   readonly invoice?: CloseOutInvoice | null;
   /** Parts on no non-void invoice ("2 parts aren't on an invoice yet."). */
   readonly unbilledParts?: number;
+  /** M3d: required forms not submitted on any visit that counts; never blocks (spec §7.4). The caller passes [] on synced jobs. */
+  readonly reminders?: ReadonlyArray<{ readonly name: string; readonly href: string }>;
   readonly pending: boolean;
   readonly error: string | null;
   readonly onConfirm: (action: SheetAction, options: SheetConfirmOptions) => void;
@@ -76,6 +81,17 @@ export function CloseOutSheet({
   const copy = buildActionSheetCopy(shown);
   const blocked = shown === 'close_out' ? relevantBlockers(blockers) : [];
   const closeOutReady = shown === 'close_out' && blocked.length === 0;
+  const showReminder = reminderVisible(shown, true, reminders);
+  const reminder = showReminder ? (
+    <div className="space-y-1.5" aria-label="Forms not submitted">
+      <p className="text-[15px] font-medium">Not submitted yet:</p>
+      {reminders.map((r) => (
+        <Link key={r.href} href={r.href} className="flex h-11 items-center rounded-xl border border-border-input px-3 text-[15px] text-link">
+          Fill in “{r.name}”
+        </Link>
+      ))}
+    </div>
+  ) : null;
   const warnings = closeOutReady
     ? [closeOutInvoiceWarning(invoice), unbilledPartsWarning(unbilledParts)].filter((w): w is string => w !== null)
     : [];
@@ -116,12 +132,18 @@ export function CloseOutSheet({
             </ul>
           )}
 
+          {/* Blocked: the reminder sits under the blocker list. */}
+          {blocked.length > 0 && reminder}
+
           {warnings.map((w) => (
             <p key={w} className="rounded-md border border-warning-border bg-warning-light px-3 py-2.5 text-[15px] text-foreground">
               {w}
             </p>
           ))}
 
+          {/* Ready: invoice and parts warnings, then the reminder, then the confirm. */}
+          {blocked.length === 0 && reminder}
+
           {shown === 'on_hold' && (
             <div className="space-y-3">
               <label className="block space-y-1.5">
```

- [ ] **Step 2: The card and the fill page.** `src/components/tech/forms/forms-card.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { fillHref, formChips } from '@/lib/tech/form-copy';
import type { TechFormsView } from '@/lib/tech/form-view';

const FILTER_FROM = 10;

/**
 * The job page's Forms card, directly after the summary (M3d spec §7.2): the
 * visit's forms with their chips, `Add a form` for writers. Refetches when
 * `refreshKey` changes (a status tap) and when the tab becomes visible.
 */
export function FormsCard({
  jobId,
  visitId,
  refreshKey,
  summaryFailed = false,
  onLoaded,
}: {
  readonly jobId: string;
  /** The job summary failed to load, so the visit is unknown: show the error state, not a skeleton forever. */
  readonly summaryFailed?: boolean;
  /** undefined while the job summary is still loading. */
  readonly visitId: string | null | undefined;
  readonly refreshKey: number;
  readonly onLoaded?: (view: TechFormsView | null) => void;
}) {
  const [view, setView] = useState<TechFormsView | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  const load = useCallback(async () => {
    if (!visitId) return;
    try {
      const res = await fetch(`/api/tech/jobs/${jobId}/forms?visit=${visitId}`);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) {
        setView(body.data as TechFormsView);
        setState('ok');
        onLoadedRef.current?.(body.data as TechFormsView);
      } else {
        setState('error');
        onLoadedRef.current?.(null);
      }
    } catch {
      setState('error');
    }
  }, [jobId, visitId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const others = view?.otherForms ?? [];
  const shownOthers = filter.trim()
    ? others.filter((o) => o.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : others;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-[17px]">
          Forms{view && view.visitNumber > 1 ? <span className="font-normal text-muted-foreground"> · Visit #{view.visitNumber}</span> : null}
        </CardTitle>
        {view?.canWrite && (
          <Button variant="outline" className="h-11 rounded-xl px-3 text-[15px]" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden="true" /> Add a form
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {visitId === undefined && summaryFailed ? (
          <p role="alert" className="text-[15px] text-danger-strong">Couldn&apos;t load forms.</p>
        ) : visitId === undefined ? (
          <Skeleton className="h-12 w-full" />
        ) : visitId === null ? (
          <p className="text-[15px] text-muted-foreground">No visit on this job yet.</p>
        ) : state === 'loading' ? (
          <Skeleton className="h-12 w-full" />
        ) : state === 'error' || !view ? (
          <p role="alert" className="text-[15px] text-danger-strong">
            Couldn&apos;t load forms.{' '}
            <button type="button" className="min-h-11 underline" onClick={() => void load()}>Try again</button>
          </p>
        ) : view.forms.length === 0 ? (
          <p className="text-[15px] text-muted-foreground">No forms for this job.</p>
        ) : (
          <ul className="divide-y">
            {view.forms.map((f) => {
              const chips = formChips(f);
              return (
                <li key={f.formId}>
                  <Link href={fillHref(jobId, f.formId, view.visitId)} className="flex min-h-11 items-center gap-2 py-2.5 text-[15px] active:bg-accent">
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="block font-medium">{f.name}</span>
                      <span className="flex flex-wrap gap-1.5">
                        <span className="rounded-[3px] border px-1.5 py-0.5 text-[13px]">{chips.status}</span>
                        {chips.required && chips.status !== 'Submitted' && (
                          <span className="rounded-[3px] border border-warning-border bg-warning-light px-1.5 py-0.5 text-[13px] text-warning-strong">Required</span>
                        )}
                      </span>
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <Sheet open={adding} onOpenChange={setAdding}>
        <SheetContent side="bottom" className="max-h-[88dvh] gap-3 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
          <SheetHeader>
            <SheetTitle className="text-[17px]">Add a form</SheetTitle>
          </SheetHeader>
          <div className="space-y-2 overflow-y-auto px-4">
            {others.length > FILTER_FROM && (
              <Input placeholder="Filter forms…" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-11 rounded-xl text-[15px] md:text-[15px]" />
            )}
            {shownOthers.length === 0 ? (
              <p className="text-[15px] text-muted-foreground">No other forms.</p>
            ) : (
              <ul className="divide-y">
                {shownOthers.map((o) => (
                  <li key={o.formId}>
                    <Link href={view ? fillHref(jobId, o.formId, view.visitId) : '#'} className="flex min-h-11 items-center py-2.5 text-[15px] active:bg-accent">
                      {o.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </Card>
  );
}
```

`src/components/tech/forms/form-field-input.tsx`:

```tsx
'use client';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FORM_LIMITS, type FormField } from '@/lib/forms/form-schema';
import { answerText, numberInputState, rangeNote, stripControlChars } from '@/lib/forms/form-values';
import { numberNote } from '@/lib/tech/form-copy';
import { toggleSign, type InputValue } from '@/lib/tech/form-fill-state';

const COUNT_FROM = 0.8;

function Counter({ value, max }: { readonly value: string; readonly max: number }) {
  if (value.length < max * COUNT_FROM) return null;
  return <span className="block text-right font-mono text-[13px] tabular-nums text-muted-foreground">{value.length}/{max}</span>;
}

/** One answer control (M3d spec §7.3). `readOnly` renders the answer text. */
export function FormFieldInput({
  field,
  value,
  readOnly,
  highlight,
  onChange,
  onBlur,
  onFocusInput,
}: {
  readonly field: FormField;
  readonly value: InputValue | undefined;
  readonly readOnly: boolean;
  /** "Answer this." or "Fix the highlighted answers." target. */
  readonly highlight: string | null;
  readonly onChange: (v: InputValue) => void;
  /** Text and number inputs: blur saves at once and frees the footer. */
  readonly onBlur: () => void;
  readonly onFocusInput: () => void;
}) {
  const label = (
    <span className="flex items-baseline gap-2">
      <span className="text-[15px] font-medium">{field.label}</span>
      {field.required && <span className="text-[13px] text-muted-foreground">Required</span>}
    </span>
  );
  const help = field.help ? <span className="block text-[13px] text-muted-foreground">{field.help}</span> : null;
  const flag = highlight ? <span role="alert" className="block text-[13px] text-danger-strong">{highlight}</span> : null;

  if (field.type === 'heading') {
    return <h3 className="pt-2 text-[15px] font-semibold">{field.label}</h3>;
  }

  if (readOnly) {
    const v = field.type === 'number' ? numberInputState(typeof value === 'string' ? value : '') : null;
    const parsed = field.type === 'number' ? (v?.kind === 'value' ? v.value : undefined)
      : field.type === 'checkbox' ? (value === true ? true : undefined)
      : (typeof value === 'string' && value !== '' ? value : undefined);
    return (
      <div className="space-y-0.5">
        {label}
        <p className="text-[15px]">{answerText(field, parsed)}</p>
      </div>
    );
  }

  switch (field.type) {
    case 'checkbox':
      return (
        <label className="flex min-h-11 items-center gap-3">
          <input type="checkbox" className="size-5" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span className="flex-1">{label}{help}{flag}</span>
        </label>
      );
    case 'yes_no':
    case 'choice': {
      const options = field.type === 'yes_no'
        ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }, ...(field.allowNa ? [{ id: 'na', label: 'N/A' }] : [])]
        : field.options;
      return (
        <fieldset className="space-y-1">
          <legend>{label}</legend>
          {help}
          <div className={field.type === 'yes_no' ? 'flex flex-wrap gap-2' : 'space-y-1'}>
            {options.map((o) => (
              <label key={o.id} className="flex min-h-11 items-center gap-2 rounded-xl border border-border-input px-3">
                <input type="radio" name={field.id} checked={value === o.id} onChange={() => onChange(o.id)} />
                {o.label}
              </label>
            ))}
          </div>
          {flag}
        </fieldset>
      );
    }
    case 'short_text':
    case 'long_text': {
      const max = field.type === 'short_text' ? FORM_LIMITS.shortText : FORM_LIMITS.longText;
      const text = typeof value === 'string' ? value : '';
      const common = {
        value: text,
        maxLength: max,
        onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(stripControlChars(e.target.value)),
        onBlur,
        onFocus: onFocusInput,
        className: 'rounded-xl text-[15px] md:text-[15px]',
      };
      return (
        <label className="block space-y-1">
          {label}
          {help}
          {field.type === 'short_text' ? <Input {...common} className={`h-11 ${common.className}`} /> : <Textarea rows={4} {...common} />}
          <Counter value={text} max={max} />
          {flag}
        </label>
      );
    }
    case 'number': {
      const raw = typeof value === 'string' ? value : '';
      const st = numberInputState(raw);
      const note = numberNote(st.kind) ?? (st.kind === 'value' ? rangeNote(field, st.value) : null);
      const showSign = field.usualMin === undefined || field.usualMin < 0;
      return (
        <div className="space-y-1">
          <label className="block space-y-1">
            {label}
            {help}
            <span className="flex items-center gap-2">
              <Input
                inputMode="decimal"
                value={raw}
                onChange={(e) => onChange(e.target.value)}
                onBlur={onBlur}
                onFocus={onFocusInput}
                className="h-11 rounded-xl font-mono text-[15px] tabular-nums md:text-[15px]"
              />
              {field.unit && <span className="text-[15px] text-muted-foreground">{field.unit}</span>}
            </span>
          </label>
          {showSign && (
            <button type="button" aria-label="Switch sign" className="h-11 min-w-11 rounded-xl border border-border-input px-3 text-[15px]" onClick={() => onChange(toggleSign(raw))}>
              ±
            </button>
          )}
          {note && <span className="block text-[13px] text-muted-foreground">{note}</span>}
          {flag}
        </div>
      );
    }
  }
}
```

`src/components/tech/forms/form-fill-client.tsx` (refs mirror the latest values for async callbacks; `dirty` / `answered` are state mirrors because refs can't be read during render; `confirmSubmit` follows `submitStep`; a failed re-read backs off instead of freezing the page):

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { FormFieldInput } from '@/components/tech/forms/form-field-input';
import { useIdempotencyKey } from '@/hooks/use-idempotency-key';
import { mintKey } from '@/lib/http/idempotency-codes';
import { classifyWriteError } from '@/lib/tech/invoice-client-errors';
import { outcomeEvent } from '@/lib/tech/invoice-key-state';
import { ESTIMATE_INTENTS_KEY } from '@/lib/tech/estimate-intents';
import { postJson } from '@/components/tech/invoice/post-json';
import { answerText, applyChanges, valuesTooLarge, type Changes, type FieldValue, type FormValues } from '@/lib/forms/form-values';
import { utf8Bytes, type FormField } from '@/lib/forms/form-schema';
import {
  afterLanded, buildChanges, carryForNewVersion, clearAllChanges, inputsFromValues, mergeIntoInputs, nextLastValid, parseInput,
  submitBlock, unparsedIds, type InputValue, type Inputs,
} from '@/lib/tech/form-fill-state';
import { KEEPALIVE_MAX_BYTES, nextSaveState, nextWakeAt, SAVE_IDLE, saveDue, submitStep, type SaveEvent, type SaveState } from '@/lib/tech/form-save-machine';
import {
  backHref, dayShort, FOREIGN_CHANGE, firstName, fillHref, missingRequiredLine, readOnlyCopy, statusLine, SUBMITTED_BY_OTHER, SUBMITTED_ON,
  type StatusPhase,
} from '@/lib/tech/form-copy';
import type { TechFormView } from '@/lib/tech/form-view';

interface DraftBody {
  readonly appointmentId: string;
  readonly formVersion: number;
  readonly baseRevision: number;
  readonly saveId: string;
  readonly changes: Changes;
}
interface SubmitIntent {
  readonly path: string;
  readonly payload: Omit<DraftBody, 'saveId'>;
  /** The base the changes were made against: STALE / FORM_CHANGED recovery merges `payload.changes` over the re-read row. */
  readonly base: FormValues;
}

const GONE = 'This form is no longer on this job.';
const FIX_NUMBERS = 'Fix the highlighted answers.';
const ANSWER_THIS = 'Answer this.';

const nonNull = (c: Changes): FormValues =>
  Object.fromEntries(Object.entries(c).filter((e): e is [string, FieldValue] => e[1] !== null));

type Load = { kind: 'loading' } | { kind: 'ok'; view: TechFormView } | { kind: 'gone' } | { kind: 'error' };

async function getView(jobId: string, formId: string, visitId: string): Promise<{ status: number | null; view: TechFormView | null; code: string | null }> {
  try {
    const res = await fetch(`/api/tech/jobs/${jobId}/forms/${formId}?visit=${visitId}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, view: res.ok && body?.success ? (body.data as TechFormView) : null, code: body?.error?.code ?? null };
  } catch {
    return { status: null, view: null, code: null };
  }
}

/** The fill page (M3d spec §7.3). Answers save to the server as the technician types; submit is keyed. */
export function FormFillClient({
  jobId, formId, visitId, from,
}: { readonly jobId: string; readonly formId: string; readonly visitId: string; readonly from: string | null }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [inputs, setInputsState] = useState<Inputs>({});
  const [phase, setPhase] = useState<StatusPhase>('blank');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [savedByOther, setSavedByOther] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [notSaved, setNotSaved] = useState<readonly string[]>([]);
  const [highlights, setHighlights] = useState<Readonly<Record<string, string>>>({});
  const [topLine, setTopLine] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [save, setSave] = useState<SaveState>(SAVE_IDLE);
  // Render mirrors of the refs below (refs can't be read during render).
  const [dirty, setDirty] = useState(false);
  const [answered, setAnswered] = useState(false);

  // Refs hold the latest values for async callbacks (no stale closures).
  const viewRef = useRef<TechFormView | null>(null);
  const fieldsRef = useRef<readonly FormField[]>([]);
  const inputsRef = useRef<Inputs>({});
  const baseRef = useRef<FormValues>({});
  const touchedRef = useRef<Set<string>>(new Set());
  const lastValidRef = useRef<Record<string, number>>({});
  const revisionRef = useRef(0);
  const versionRef = useRef(1);
  const pendingRef = useRef<DraftBody | null>(null);
  const flightRef = useRef<Promise<boolean> | null>(null);
  const saveRef = useRef<SaveState>(SAVE_IDLE);
  const bannerShown = useRef(false);

  const intentId = `form:submit:${formId}:${visitId}`;
  const { state: keyState, dispatch: keyDispatch } = useIdempotencyKey({
    intentId, requestId: jobId, persist: true, storageKey: ESTIMATE_INTENTS_KEY, rehydrate: true,
  });

  const dispatchSave = useCallback((e: SaveEvent) => {
    saveRef.current = nextSaveState(saveRef.current, e);
    setSave(saveRef.current);
  }, []);
  const setInputs = useCallback((next: Inputs) => {
    inputsRef.current = next;
    setInputsState(next);
  }, []);
  /** Call after touching touchedRef / pendingRef / baseRef. */
  const syncFlags = useCallback(() => {
    setDirty(touchedRef.current.size > 0 || pendingRef.current !== null);
    setAnswered(Object.keys(baseRef.current).length > 0 || touchedRef.current.size > 0);
  }, []);
  const fieldName = useCallback((id: string) => fieldsRef.current.find((f) => f.id === id), []);
  const notSavedLines = useCallback((ids: Iterable<string>) => {
    const out: string[] = [];
    for (const id of ids) {
      const f = fieldName(id);
      if (!f) continue;
      const p = parseInput(f, inputsRef.current[id]);
      const v = p.kind === 'value' ? p.value ?? undefined : lastValidRef.current[id];
      out.push(`Not saved: ${f.label} · ${answerText(f, v)}`);
    }
    return out;
  }, [fieldName]);

  const applyView = useCallback((v: TechFormView) => {
    viewRef.current = v;
    fieldsRef.current = v.form.fields;
    versionRef.current = v.form.version;
    const values = v.submission?.values ?? {};
    baseRef.current = values;
    revisionRef.current = v.submission?.revision ?? 0;
    touchedRef.current = new Set();
    lastValidRef.current = Object.fromEntries(Object.entries(values).filter(([, x]) => typeof x === 'number')) as Record<string, number>;
    setInputs(inputsFromValues(v.form.fields, values));
    setSavedAt(v.submission && v.submission.values && Object.keys(v.submission.values).length > 0 ? v.submission.updatedAt : null);
    setSavedByOther(v.submission && !v.submission.updatedByMe ? firstName(v.submission.updatedByName) : null);
    setPhase(v.submission?.status === 'submitted' ? 'submitted' : v.writeBlockedReason ? 'blocked' : v.submission ? 'saved' : 'blank');
    setLoad({ kind: 'ok', view: v });
    syncFlags();
  }, [setInputs, syncFlags]);

  /** The re-read view; 'gone' (404 / archived, the page says so); null = no answer (network, 5xx). */
  const refetch = useCallback(async (): Promise<TechFormView | 'gone' | null> => {
    const r = await getView(jobId, formId, visitId);
    if (r.view) return r.view;
    if (r.status === 404 || r.code === 'FORM_ARCHIVED') {
      setLoad({ kind: 'gone' });
      return 'gone';
    }
    return null;
  }, [jobId, formId, visitId]);

  /** STALE / FORM_CHANGED / a refusal during autosave or submit: re-read and merge or go read-only. */
  const reconcile = useCallback(async (code: string | null, mineOverride?: Changes, baseOverride?: FormValues) => {
    const old = fieldsRef.current;
    const mine = mineOverride ?? buildChanges(old, inputsRef.current, touchedRef.current, lastValidRef.current);
    const base = baseOverride ?? baseRef.current;
    const v = await refetch();
    if (v === 'gone') {
      setNotSaved(notSavedLines(Object.keys(mine)));
      dispatchSave({ type: 'stop', reason: 'blocked' });
      return;
    }
    if (v === null) {
      // The re-read itself failed (a network blip): back off and try again, never freeze the page.
      dispatchSave({ type: 'unknown', now: Date.now(), retryAfterMs: null });
      setPhase('retrying');
      return;
    }
    if (v.submission?.status === 'submitted') {
      const lines = notSavedLines(Object.keys(mine));
      applyView(v);
      setNotice(SUBMITTED_BY_OTHER(v.submission.submittedByName ?? 'Someone'));
      setNotSaved(lines);
      return;
    }
    if (v.writeBlockedReason) {
      const lines = notSavedLines(Object.keys(mine));
      applyView(v);
      setNotSaved(lines);
      dispatchSave({ type: 'stop', reason: 'blocked' });
      return;
    }
    let fields = old;
    let carriedBase = base;
    let carriedMine = mine;
    if (code === 'FORM_CHANGED' || v.form.version !== versionRef.current) {
      fields = v.form.fields;
      const carried = carryForNewVersion(fields, base, mine);
      carriedBase = carried.base;
      carriedMine = carried.mine;
      setNotSaved(notSavedLines(carried.dropped));
      setNotice('The office changed this form. Check your answers.');
    }
    const theirs = v.submission?.values ?? {};
    // A recovered submit's changes aren't in the inputs yet: rebuild those inputs from them.
    const mineInputs = mineOverride ? inputsFromValues(fields, nonNull(carriedMine)) : inputsRef.current;
    const merged = mergeIntoInputs(fields, carriedBase, carriedMine, theirs, mineInputs, new Set(Object.keys(carriedMine)));
    viewRef.current = v;
    fieldsRef.current = fields;
    versionRef.current = v.form.version;
    baseRef.current = theirs;
    revisionRef.current = v.submission?.revision ?? 0;
    touchedRef.current = new Set(Object.keys(carriedMine));
    setInputs(merged.inputs);
    setLoad({ kind: 'ok', view: v });
    if (merged.foreignChange && !bannerShown.current) {
      bannerShown.current = true;
      setNotice(FOREIGN_CHANGE);
    }
    syncFlags();
    dispatchSave({ type: 'resume' });
    dispatchSave({ type: 'edit', now: Date.now() });
  }, [applyView, dispatchSave, notSavedLines, refetch, setInputs, syncFlags]);

  const currentChanges = useCallback(
    () => buildChanges(fieldsRef.current, inputsRef.current, touchedRef.current, lastValidRef.current),
    [],
  );

  /** One PUT; resolves true only when it landed. */
  const sendDraft = useCallback(async (kind: 'send_new' | 'send_retry'): Promise<boolean> => {
    let body = kind === 'send_retry' ? pendingRef.current : null;
    if (!body) {
      const changes = currentChanges();
      if (Object.keys(changes).length === 0) return true;
      const applied = applyChanges(fieldsRef.current, baseRef.current, changes);
      if (applied.ok && valuesTooLarge(applied.values)) {
        dispatchSave({ type: 'stop', reason: 'too_large' });
        setPhase('too_large');
        return false;
      }
      body = { appointmentId: visitId, formVersion: versionRef.current, baseRevision: revisionRef.current, saveId: mintKey(), changes };
    }
    pendingRef.current = body;
    syncFlags();
    dispatchSave({ type: 'sent', now: Date.now() });
    setPhase('saving');
    const text = JSON.stringify(body);
    const flight = (async () => {
      let res: Response | null = null;
      try {
        res = await fetch(`/api/tech/jobs/${jobId}/forms/${formId}/draft`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text, keepalive: utf8Bytes(text) <= KEEPALIVE_MAX_BYTES,
        });
      } catch {
        res = null;
      }
      const env = res ? await res.json().catch(() => null) : null;
      const sent = body!;
      if (res && res.ok && env?.success) {
        revisionRef.current = Number(env.data.revision);
        const r = afterLanded(fieldsRef.current, baseRef.current, sent.changes, inputsRef.current, touchedRef.current);
        baseRef.current = r.base;
        touchedRef.current = r.touched;
        pendingRef.current = null;
        syncFlags();
        setSavedAt(String(env.data.savedAt));
        setSavedByOther(null);
        setPhase('saved');
        dispatchSave({ type: 'landed' });
        return true;
      }
      const status = res?.status ?? null;
      const code: string | null = env?.error?.code ?? null;
      if (status === null || status >= 500 || status === 429) {
        const ra = Number(res?.headers.get('Retry-After'));
        dispatchSave({ type: 'unknown', now: Date.now(), retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null });
        setPhase('retrying');
        return false;
      }
      if (status === 401) {
        dispatchSave({ type: 'stop', reason: 'signed_out' });
        setPhase('signed_out');
        setNotSaved(notSavedLines(touchedRef.current));
        return false;
      }
      if (status === 400) {
        const tooLarge = Array.isArray(env?.error?.details?.path) && env.error.details.path[0] === 'values';
        if (tooLarge) pendingRef.current = null;
        syncFlags();
        dispatchSave({ type: 'stop', reason: tooLarge ? 'too_large' : 'bad_request' });
        setPhase(tooLarge ? 'too_large' : 'bad_request');
        return false;
      }
      pendingRef.current = null;
      syncFlags();
      dispatchSave({ type: 'landed' });
      if (status === 404) setNotice(GONE);
      await reconcile(code);
      return false;
    })();
    flightRef.current = flight;
    const landed = await flight;
    flightRef.current = null;
    return landed;
  }, [currentChanges, dispatchSave, formId, jobId, notSavedLines, reconcile, syncFlags, visitId]);

  // Autosave timer: wake at the machine's next due time.
  useEffect(() => {
    const wake = nextWakeAt(save, dirty);
    if (wake === null) return;
    const t = setTimeout(() => {
      const action = saveDue(saveRef.current, Date.now(), touchedRef.current.size > 0 || pendingRef.current !== null);
      if (action) void sendDraft(action);
    }, Math.max(0, wake - Date.now()));
    return () => clearTimeout(t);
  }, [save, dirty, sendDraft]);

  // hidden / pagehide save at once (bypassing the 3 s floor, keeping one in flight).
  useEffect(() => {
    const flush = () => {
      if (touchedRef.current.size === 0 && pendingRef.current === null) return;
      dispatchSave({ type: 'flush' });
      const action = saveDue(saveRef.current, Date.now(), true);
      if (action) void sendDraft(action);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [dispatchSave, sendDraft]);

  const submitFlow = useCallback(async (intent: SubmitIntent | null) => {
    let stored = intent;
    if (!stored) {
      const payload = { appointmentId: visitId, formVersion: versionRef.current, baseRevision: revisionRef.current, changes: currentChanges() };
      stored = { path: `/api/tech/jobs/${jobId}/forms/${formId}/submit`, payload, base: baseRef.current };
      const hash = JSON.stringify(stored.payload);
      keyDispatch({ type: 'open', bodyHash: hash, body: stored, mint: mintKey });
      const pre = keyDispatch({ type: 'edit', bodyHash: hash, body: stored, mint: mintKey });
      if (pre.phase !== 'armed' && pre.phase !== 'unknown') return;
    }
    const s = keyDispatch({ type: 'sent' });
    if (s.phase !== 'sent') return;
    const sent = s.body as SubmitIntent;
    dispatchSave({ type: 'lock' });
    setPhase('submit_sent');
    const res = await postJson(sent.path, sent.payload, s.key);
    const env = res.status === null ? null : res.envelope;
    const code = env?.error?.code ?? null;
    const outcome = classifyWriteError(res.status, code, env?.error?.details);
    if (outcome === 'retry_same_key_after_refetch' || outcome === 'wait_then_refetch') {
      keyDispatch({ type: 'unknown' });
      setPhase('submit_unknown');
      return;
    }
    const ev = outcomeEvent(outcome, false);
    if (ev) keyDispatch({ type: ev });
    dispatchSave({ type: 'unlock' });
    if (outcome === 'success_refetch' || code === 'FORM_SUBMITTED') {
      // A submitted page never autosaves: a draft still queued behind the submit is dropped, not retried.
      pendingRef.current = null;
      dispatchSave({ type: 'submitted' });
      const v = await refetch();
      if (v && v !== 'gone') applyView(v);
      return;
    }
    if (code === 'FORM_INCOMPLETE') {
      const ids = (env?.error?.details as { fieldIds?: string[] } | undefined)?.fieldIds ?? [];
      setHighlights(Object.fromEntries(ids.map((id) => [id, ANSWER_THIS])));
      setTopLine(missingRequiredLine(ids.length));
      setPhase('saved');
      return;
    }
    // STALE / FORM_CHANGED: merge (or carry), unlock, show the line; a new tap and confirm send a new body (a new key).
    await reconcile(code, sent.payload.changes, sent.base);
  }, [applyView, currentChanges, dispatchSave, formId, jobId, keyDispatch, reconcile, refetch, visitId]);

  // Load, then recover a pending submit of this form on this visit (the page's own intent).
  useEffect(() => {
    void (async () => {
      const r = await getView(jobId, formId, visitId);
      if (r.view) applyView(r.view);
      else setLoad(r.status === 404 || r.code === 'FORM_ARCHIVED' ? { kind: 'gone' } : { kind: 'error' });
    })();
  }, [jobId, formId, visitId, applyView]);
  /** The mount recovery of this page's own submit intent, started once per intent (M3c's keyed-ref pattern; StrictMode runs effects twice). */
  const recovery = useRef<{ key: string; done: Promise<void> } | null>(null);
  useEffect(() => {
    if (load.kind !== 'ok' || keyState.phase !== 'unknown') return;
    if (recovery.current?.key === intentId) return;
    recovery.current = { key: intentId, done: submitFlow(keyState.body as SubmitIntent) };
  }, [load.kind, keyState, submitFlow, intentId]);

  const change = useCallback((field: FormField, v: InputValue): void => {
    setNotice((n) => (n === FOREIGN_CHANGE ? n : null));
    setHighlights((h) => {
      if (!(field.id in h)) return h;
      const rest = { ...h };
      delete rest[field.id];
      return rest;
    });
    lastValidRef.current = nextLastValid(lastValidRef.current, field, v);
    touchedRef.current = new Set([...touchedRef.current, field.id]);
    setInputs({ ...inputsRef.current, [field.id]: v });
    syncFlags();
    dispatchSave({ type: 'edit', now: Date.now() });
  }, [dispatchSave, setInputs, syncFlags]);

  async function onSubmitTap(): Promise<void> {
    const block = submitBlock(fieldsRef.current, inputsRef.current);
    if (block?.kind === 'unparsed') {
      setHighlights(Object.fromEntries(block.fieldIds.map((id) => [id, FIX_NUMBERS])));
      setTopLine(FIX_NUMBERS);
      document.getElementById(`q-${block.fieldIds[0]}`)?.querySelector('input')?.focus();
      return;
    }
    if (block?.kind === 'missing') {
      setHighlights(Object.fromEntries(block.fieldIds.map((id) => [id, ANSWER_THIS])));
      setTopLine(missingRequiredLine(block.fieldIds.length));
      return;
    }
    setTopLine(null);
    setConfirmOpen(true);
  }

  /**
   * Submit (spec §7.3): cancel the debounce, wait for the write in flight, re-send
   * a pending unknown draft with its own body and saveId and see it land, then
   * send the submit with the latest revision. A draft that doesn't land unlocks
   * the page instead: the technician sees the save line and taps Submit again.
   */
  async function confirmSubmit(): Promise<void> {
    setConfirmOpen(false);
    dispatchSave({ type: 'lock' });
    for (let round = 0; round < 3; round++) {
      const step = submitStep(saveRef.current, pendingRef.current !== null, flightRef.current !== null);
      if (step === 'send_submit') {
        await submitFlow(null);
        return;
      }
      if (step === 'await_flight') {
        await flightRef.current;
        continue;
      }
      if (!(await sendDraft('send_retry'))) break;
    }
    dispatchSave({ type: 'unlock' });
  }

  function clearAnswers(): void {
    setClearOpen(false);
    const changes = clearAllChanges(baseRef.current);
    touchedRef.current = new Set([...touchedRef.current, ...Object.keys(changes)]);
    lastValidRef.current = {};
    setInputs(inputsFromValues(fieldsRef.current, {}));
    syncFlags();
    dispatchSave({ type: 'flush' });
  }

  if (load.kind === 'loading') return <Skeleton className="h-64 w-full rounded-xl" />;
  if (load.kind === 'gone' || load.kind === 'error') {
    return (
      <Card>
        <CardContent className="space-y-4 py-6">
          <p role="alert" className="text-[17px] font-medium">{load.kind === 'gone' ? GONE : "Couldn't load this form."}</p>
          <Link href={`/tech/jobs/${jobId}`} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
            <ArrowLeft className="size-4" /> Back to job
          </Link>
        </CardContent>
      </Card>
    );
  }

  const v = load.view;
  const submitted = v.submission?.status === 'submitted' || phase === 'submitted';
  const locked = keyState.phase === 'sent' || keyState.phase === 'unknown';
  const writable = v.canWrite && !submitted && !locked && from === null && save.stop !== 'blocked' && save.stop !== 'signed_out';
  const back = backHref({ jobId, formId, visitId, myVisit: v.myVisit, from });
  const unparsed = unparsedIds(v.form.fields, inputs).length;
  const line = statusLine({
    phase: locked ? (keyState.phase === 'sent' ? 'submit_sent' : 'submit_unknown') : submitted ? 'submitted' : phase,
    savedAt, savedByOther, unparsedCount: submitted ? 0 : unparsed,
    submittedAt: v.submission?.submittedAt ?? null, submittedByName: v.submission?.submittedByName ?? null, now: new Date(),
  });
  const reasons = readOnlyCopy(v.writeBlockedReason, { myRowCancelled: v.myRowCancelled });

  return (
    <div className="space-y-4 pb-28">
      <Link href={back.href} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
        <ArrowLeft className="size-4" /> {back.label}
      </Link>
      <header className="space-y-1">
        <h1 className="text-[20px] font-semibold">{v.form.name}</h1>
        {v.form.description && <p className="text-[15px] text-muted-foreground">{v.form.description}</p>}
        {line && <p className="text-[13px] text-muted-foreground">{line}</p>}
      </header>

      {v.submittedOn && !submitted && from === null && (
        <p className="rounded-md border border-border bg-surface-raised px-3 py-2 text-[15px]">
          {SUBMITTED_ON(v.submittedOn.appointmentNumber, dayShort(v.submittedOn.submittedAt))}{' '}
          <Link className="text-link underline" href={fillHref(jobId, formId, v.submittedOn.appointmentId, visitId)}>
            View visit #{v.submittedOn.appointmentNumber}&apos;s answers
          </Link>
        </p>
      )}
      {reasons.map((r) => (
        <p key={r} role="status" className="rounded-md border border-border bg-surface-raised px-3 py-2 text-[15px]">{r}</p>
      ))}
      {notice && <p role="status" className="rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px]">{notice}</p>}
      {phase === 'signed_out' && (
        <Link href="/tech-login" className="inline-flex h-11 items-center rounded-xl border px-4 text-[15px]">Sign in</Link>
      )}
      {notSaved.length > 0 && (
        <ul className="space-y-0.5 text-[13px] text-muted-foreground">{notSaved.map((l) => <li key={l}>{l}</li>)}</ul>
      )}
      {topLine && <p role="alert" className="text-[15px] text-danger-strong">{topLine}</p>}

      <Card>
        <CardContent className="space-y-4 py-4">
          {v.form.fields.map((f) => (
            <div key={f.id} id={`q-${f.id}`}>
              <FormFieldInput
                field={f}
                value={inputs[f.id]}
                readOnly={!writable}
                highlight={highlights[f.id] ?? null}
                onChange={(x) => change(f, x)}
                onBlur={() => {
                  setTyping(false);
                  dispatchSave({ type: 'flush' });
                }}
                onFocusInput={() => setTyping(true)}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {writable && answered && (
        <Button variant="outline" className="h-11 rounded-xl px-4 text-[15px]" onClick={() => setClearOpen(true)}>Clear answers</Button>
      )}

      <footer className={`${typing ? '' : 'sticky bottom-0'} space-y-2 border-t bg-background py-3`}>
        <p aria-live="polite" className="text-[13px] text-muted-foreground">{line === 'Saving…' ? '' : line}</p>
        {phase === 'bad_request' && (
          <Button variant="outline" className="h-11 rounded-xl" onClick={() => dispatchSave({ type: 'try_again' })}>Try again</Button>
        )}
        {keyState.phase === 'unknown' && (
          <Button variant="outline" className="h-11 rounded-xl" onClick={() => void submitFlow(keyState.body as SubmitIntent)}>Try again</Button>
        )}
        {submitted ? (
          <Link href={back.href} className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-primary text-[16px] text-primary-foreground">
            {back.label}
          </Link>
        ) : writable ? (
          <Button className="h-12 w-full rounded-xl text-[16px]" onClick={() => void onSubmitTap()}>Submit form</Button>
        ) : null}
      </footer>

      <Sheet open={confirmOpen} onOpenChange={setConfirmOpen}>
        <SheetContent side="bottom" className="gap-3 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
          <SheetHeader>
            <SheetTitle className="text-[17px]">Submit “{v.form.name}”?</SheetTitle>
            <SheetDescription className="text-[15px]">After this, only the office can reopen it.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-2 px-4">
            <Button className="h-12 rounded-xl text-[16px]" onClick={() => void confirmSubmit()}>Submit</Button>
            <Button variant="outline" className="h-12 rounded-xl text-[16px]" onClick={() => setConfirmOpen(false)}>Go back</Button>
          </div>
        </SheetContent>
      </Sheet>
      <Sheet open={clearOpen} onOpenChange={setClearOpen}>
        <SheetContent side="bottom" className="gap-3 rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]">
          <SheetHeader>
            <SheetTitle className="text-[17px]">Clear all answers on this form?</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-2 px-4">
            <Button className="h-12 rounded-xl text-[16px]" onClick={clearAnswers}>Clear answers</Button>
            <Button variant="outline" className="h-12 rounded-xl text-[16px]" onClick={() => setClearOpen(false)}>Go back</Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
```

`src/app/tech/jobs/[id]/forms/[formId]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { FormFillClient } from '@/components/tech/forms/form-fill-client';
import { isUuid } from '@/lib/validation/uuid';

/**
 * The fill page (M3d spec §7.3): `?visit=<aid>` is required; `&from=<aid>`
 * marks a read-only look at another visit's answers (its back link returns to
 * `from`). Next.js 16: params and searchParams are Promises.
 */
export default async function TechFormFillPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string; formId: string }>;
  readonly searchParams: Promise<{ visit?: string | string[]; from?: string | string[] }>;
}) {
  const { id, formId } = await params;
  const { visit, from } = await searchParams;
  if (!isUuid(id) || !isUuid(formId) || typeof visit !== 'string' || !isUuid(visit)) notFound();
  const fromVisit = typeof from === 'string' && isUuid(from) ? from.toLowerCase() : null;
  const f = formId.toLowerCase();
  const v = visit.toLowerCase();
  // Keyed: `View visit #1's answers` and its Back stay on this route with other params; a fresh
  // instance per form, visit and `from` keeps refs and the submit intent from leaking across visits.
  return <FormFillClient key={`${f}:${v}:${fromVisit ?? ''}`} jobId={id} formId={f} visitId={v} from={fromVisit} />;
}
```

`src/components/tech/tech-job-detail-client.tsx` — four edits (the Site card line in Task 11 goes right after the Forms card):

1. Imports, after the `EquipmentCard` import:

```tsx
import { FormsCard } from '@/components/tech/forms/forms-card';
import { cardVisit, fillHref } from '@/lib/tech/form-copy';
import { unsubmittedRequired, type TechFormsView } from '@/lib/tech/form-view';
```

2. Replace the `invoiceState` state + `onSummaryLoaded` callback:

```tsx
  const [invoiceState, setInvoiceState] = useState<string | null>(null);
  // M3d: the Forms card's visit (spec §7.2) and its view, for the close-out reminder.
  // undefined = the summary hasn't said yet (the card shows a skeleton, not "No visit on this job yet.").
  const [formsVisit, setFormsVisit] = useState<string | null | undefined>(appointmentId ?? undefined);
  const [formsView, setFormsView] = useState<TechFormsView | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const onSummaryLoaded = useCallback((outcome: JobLoadOutcome, job: SummaryLoaded | null) => {
    setJobOutcome(outcome);
    setSummaryFailed(outcome === 'error');
    if (job) {
      setJobStatus(job.status);
      setInvoiceState(job.invoiceState);
      setFormsVisit(cardVisit(appointmentId, job.assignmentVisitId, job.activeVisitId));
    }
  }, [appointmentId]);
```

3. After `const unbilledParts = …;`:

```tsx
  const formReminders = formsView
    ? unsubmittedRequired(formsView).map((f) => ({ name: f.name, href: fillHref(id, f.formId, formsView.visitId) }))
    : [];
```

4. Pass `formReminders={formReminders}` to `<TechJobSummary … />` (after `unbilledParts={unbilledParts}`), and put the card directly after the summary, before the Estimates card:

```tsx
      <FormsCard jobId={id} visitId={formsVisit} summaryFailed={summaryFailed} refreshKey={refreshKey} onLoaded={setFormsView} />
      <EstimatesCard jobId={id} refreshKey={refreshKey} onLoaded={onEstimatesLoaded} />
```

- [ ] **Step 3: Run the suites this touches**

Run: `npx vitest run src/lib/tech/field-queries.test.ts src/components/tech src/lib/tech/form-*.test.ts`
Expected: PASS (no test file changes: `getTechJobSummary`'s tests assert fields, not the whole object).

- [ ] **Step 4: Walk it (390×844).** Dev server running. `walk-m3d-10.mts` at the repo root:

```ts
/**
 * Task 10 walk (390×844): the helper fills half (an out-of-range reading and a
 * half-typed "12."), reloads, the lead sees the draft, the helper taps Done,
 * the lead's Close out shows the reminder, the lead submits, the synced job's
 * card is writable. Deleted before commit.
 */
import { execFileSync } from "node:child_process";
import { chromium, type Page } from "playwright";

const env = { ...process.env, NODE_OPTIONS: "--conditions=react-server" };
const fx = JSON.parse(execFileSync("npx", ["tsx", "scripts/agent/m3d-walk.mts", "seed"], { encoding: "utf8", env }).trim().split("\n").pop()!) as {
  org: string; job: string; visit: string; synced: string; tokens: { admin: string; lead: string; helper: string };
};
const BASE = "http://localhost:3000";
const DEF = {
  clientToken: crypto.randomUUID(), name: "Maintenance checklist", description: null, jobTypeIds: [], required: true,
  fields: [
    { id: "f_walk000001", type: "checkbox", label: "Filter changed", required: true },
    { id: "f_walk000002", type: "checkbox", label: "Coil cleaned", required: true },
    { id: "f_walk000003", type: "checkbox", label: "Drain flushed", required: false },
    { id: "f_walk000004", type: "checkbox", label: "Thermostat checked", required: false },
    { id: "f_walk000005", type: "number", label: "Suction pressure", required: false, unit: "psi", usualMin: 100, usualMax: 140 },
  ],
};
const browser = await chromium.launch();
const phone = async (token: string): Promise<Page> => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  await ctx.addCookies([{ name: "hvac_tech_session", value: token, domain: "localhost", path: "/" }]);
  return ctx.newPage();
};
try {
  const created = await fetch(`${BASE}/api/admin/settings/forms`, {
    method: "POST", headers: { "content-type": "application/json", cookie: `hvac_admin_session=${fx.tokens.admin}`, origin: BASE }, body: JSON.stringify(DEF),
  });
  if (created.status !== 201) throw new Error(`create form ${created.status}`);

  const helper = await phone(fx.tokens.helper);
  await helper.goto(`${BASE}/tech/jobs/${fx.job}`);
  await helper.getByText("Maintenance checklist").waitFor();
  await helper.getByText("Not started").waitFor();
  await helper.getByText("Required").first().waitFor();
  await helper.screenshot({ path: "/tmp/m3d-10-job.png", fullPage: true });
  await helper.getByText("Maintenance checklist").click();
  await helper.getByLabel("Filter changed").check();
  await helper.getByLabel("Drain flushed").check();
  const psi = helper.locator("#q-f_walk000005 input[inputmode=decimal]");
  await psi.fill("180");
  await helper.getByText("Outside the usual range (100–140 psi)").waitFor();
  await psi.fill("12.");
  await helper.getByText("Not saved yet: 1 answer isn't a number.").first().waitFor();
  await helper.screenshot({ path: "/tmp/m3d-10-partial.png" });
  await psi.fill("118");
  await psi.blur();
  await helper.getByText(/^Saved · /).first().waitFor({ timeout: 15_000 });
  await helper.reload();
  await helper.getByText(/^Saved · /).first().waitFor();
  if (!(await helper.getByLabel("Filter changed").isChecked())) throw new Error("draft lost on reload");

  const lead = await phone(fx.tokens.lead);
  await lead.goto(`${BASE}/tech/jobs/${fx.job}/forms/${(await created.json()).data.id}?visit=${fx.visit}`);
  await lead.getByText(/^Saved · .* · Sam$/).first().waitFor();
  await lead.screenshot({ path: "/tmp/m3d-10-lead-draft.png" });

  await helper.goto(`${BASE}/tech/jobs/${fx.job}`);
  await helper.getByRole("button", { name: "Done" }).first().click();
  await helper.getByRole("button", { name: "Done" }).last().click();
  await lead.goto(`${BASE}/tech/jobs/${fx.job}`);
  await lead.getByRole("button", { name: "Close out" }).first().click();
  await lead.getByText("Fill in “Maintenance checklist”").waitFor();
  await lead.screenshot({ path: "/tmp/m3d-10-closeout.png" });
  await lead.getByText("Fill in “Maintenance checklist”").click();
  await lead.getByLabel("Coil cleaned").check();
  await lead.getByRole("button", { name: "Submit form" }).click();
  await lead.getByRole("button", { name: "Submit", exact: true }).click();
  await lead.getByText(/^Submitted · .* · Alex Rivera$/).first().waitFor({ timeout: 15_000 });
  await lead.screenshot({ path: "/tmp/m3d-10-submitted.png" });

  await lead.goto(`${BASE}/tech/jobs/${fx.synced}`);
  await lead.getByRole("button", { name: "Add a form" }).waitFor();
  await lead.screenshot({ path: "/tmp/m3d-10-synced.png", fullPage: true });
  console.log(JSON.stringify({ ok: true, org: fx.org }));
} finally {
  await browser.close();
  execFileSync("npx", ["tsx", "scripts/agent/m3d-walk.mts", "delete", fx.org], { encoding: "utf8", env, stdio: "inherit" });
}
```

Run `npx tsx walk-m3d-10.mts`. Expected `{"ok":true,…}` and the org deleted. Look at: `/tmp/m3d-10-job.png` (Forms directly after the summary, "Maintenance checklist", `Not started`, `Required`), `/tmp/m3d-10-partial.png` ("Not saved yet: 1 answer isn't a number." in header and footer, the "Not saved yet. Finish the number." note, the `±` button), `/tmp/m3d-10-lead-draft.png` ("Saved · … · Sam"), `/tmp/m3d-10-closeout.png` ("Not submitted yet:" + "Fill in “Maintenance checklist”" above the Close out button), `/tmp/m3d-10-submitted.png` (read-only answers, "Submitted · … · Alex Rivera", primary `Back to job`), `/tmp/m3d-10-synced.png` (Forms card with `Add a form`, no close-out actions). By hand on a re-seeded fixture: throttle offline in devtools, change an answer → "Not saved yet. Retrying…", back online → `Saved`; offline again, change an answer, Submit and confirm while offline → the draft goes first and the page unlocks with the retry line (it never says the technician's own name "submitted this form"); submit offline after the draft landed → page locked with "Your last change may not have saved. Try again."; reload → the page re-sends the stored submit before unlocking; open `View visit #1's answers` from visit #2 and Back → each page shows only its own visit's state. Delete the walk script.

- [ ] **Step 5: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/components/tech/forms "src/app/tech/jobs/[id]/forms" src/lib/tech/field-queries.ts src/components/tech/tech-job-summary.tsx src/components/tech/close-out-sheet.tsx src/components/tech/tech-job-detail-client.tsx && npx vitest run
git add src/components/tech/forms/forms-card.tsx src/components/tech/forms/form-field-input.tsx src/components/tech/forms/form-fill-client.tsx "src/app/tech/jobs/[id]/forms/[formId]/page.tsx" src/lib/tech/field-queries.ts src/components/tech/tech-job-summary.tsx src/components/tech/close-out-sheet.tsx src/components/tech/tech-job-detail-client.tsx
git commit -m "$(cat <<'EOF'
feat(m3d): technician Forms card and fill page (server autosave, merge, keyed submit) and the close-out reminder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 11: Site view, photo quality with PDFs, the office Forms section

**Files:**
- Create: `src/lib/tech/site-display.ts`, `src/lib/tech/site-display.test.ts`, `src/components/tech/site/fetch-site.ts`, `src/components/tech/site/site-card.tsx`, `src/components/tech/site/site-page-client.tsx`, `src/app/tech/jobs/[id]/site/page.tsx`, `src/lib/tech/photo-resize.ts`, `src/lib/tech/photo-resize.test.ts`, `src/lib/tech/photo-prepare.ts`, `src/lib/admin/request-forms-view.ts`, `src/lib/admin/request-forms-view.test.ts`, `src/components/admin/request-forms-section.tsx`
- Modify: `src/components/tech/tech-job-detail-client.tsx` (Site card), `src/components/tech/job-photos-card.tsx` (replaced), `src/lib/tech/job-page-state.ts`, `src/lib/tech/job-page-state.test.ts`, `src/components/admin/request-detail-sheet.tsx` (re-read first)

**Interfaces:**
- Consumes: Task 10b (the job page with the Forms card); Task 7 `SiteView` & co.; Task 3 `TECH_UPLOAD_LIMIT_BYTES`, `FILE_TOO_LARGE_COPY`; Task 5 `OfficeSubmission`, `RequestForms` (types); Task 2 `answerText`, `plural`; `statusLabel` (`src/lib/tech/job-display.ts`); `formatCentsExact` (`src/lib/admin/money-format.ts`); the Task 8 site, photo and request-forms routes.
- Produces: `SITE_COPY`, `pastJobLine`, `estimateHref(jobId, estimate, isLead)` (a link only for the lead, ruling 12), `estimateTotal`, `unaddressedLine`, `membershipLines`, `siteCardLine`; `PhotoQuality`, `QUALITY_STORAGE_KEY = "tech:photo-quality"`, `STEPS`, `resizePlan`, `qualityFromStorage`, `pickPrepared`, `PHOTO_CANT_PREPARE`; `preparePhoto(file, quality)`; `PHOTO_UPLOAD_FAILED = "Couldn't upload that photo."`, `FILE_UPLOAD_FAILED`, `UPLOAD_CUSTOMER_REMOVED`, `isImageMime`; `visitLabel`, `submissionChip`, `whoWhen`, `missingLine`, `reopenDescription`, `REOPEN_*`, `UNREADABLE`; `RequestFormsSection` after `VisitsSection`.

- [ ] **Step 1: Write the failing tests** — `src/lib/tech/site-display.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { estimateHref, estimateTotal, membershipLines, pastJobLine, siteCardLine, SITE_COPY, unaddressedLine } from "./site-display";
import type { SiteView } from "./site-view";

const TZ = "America/New_York";
const view = (over: Partial<SiteView> = {}): SiteView => ({
  scope: "location", title: "Service address", pastJobs: [], unaddressedCount: 0, openEstimates: [], membership: { state: "none" }, hasCustomer: true, isLead: true, ...over,
});
const job = { id: "r", referenceNumber: "R-1", date: "2026-11-03T15:00:00.000Z", status: "completed", kind: "Maintenance", leadTechnicianName: "Alex", submittedFormNames: ["Maintenance checklist"] };
const est = (over = {}) => ({ id: "e", label: "Estimate · Nov 6 · 2 options", createdAt: "2026-11-06T15:00:00.000Z", totalCents: 481200, optionCount: 2, thisJob: false, fromFieldPulse: false, ...over });

describe("site rows (spec §8)", () => {
  it("past job line", () => {
    expect(pastJobLine(job, TZ)).toBe("Nov 3, 2026 · Maintenance · Completed · Alex · Forms: Maintenance checklist");
    expect(pastJobLine({ ...job, leadTechnicianName: null, submittedFormNames: [] }, TZ)).toBe("Nov 3, 2026 · Maintenance · Completed");
  });
  it("only this job's native open estimates link, and only for the lead (spec §7.6)", () => {
    expect(estimateHref("j", est({ thisJob: true }), true)).toBe("/tech/jobs/j/estimates/e");
    expect(estimateHref("j", est({ thisJob: true }), false)).toBeNull();
    expect(estimateHref("j", est({ thisJob: false }), true)).toBeNull();
    expect(estimateHref("j", est({ thisJob: true, fromFieldPulse: true }), true)).toBeNull();
  });
  it("estimate total", () => {
    expect(estimateTotal(est())).toBe("Up to $4,812.00");
    expect(estimateTotal(est({ optionCount: 1 }))).toBe("$4,812.00");
  });
  it("unaddressed line", () => {
    expect(unaddressedLine(0)).toBeNull();
    expect(unaddressedLine(1)).toBe("1 earlier job has no saved address.");
    expect(unaddressedLine(3)).toBe("3 earlier jobs have no saved address.");
  });
  it("membership: member, none, withheld", () => {
    const m = membershipLines({
      state: "member", planName: "Comfort Club", startedAt: "2026-03-10T15:00:00.000Z", currentPeriodEnd: "2027-04-01T16:00:00.000Z", visitsPerYear: 2,
      upcoming: [{ dueDate: "2027-05-01T16:00:00.000Z", status: "scheduled", thisJob: false }, { dueDate: "2027-11-01T16:00:00.000Z", status: "generated", thisJob: true }],
    }, TZ);
    expect(m).toEqual({
      head: "Comfort Club · Member since Mar 2026 · Paid through Apr 1, 2027",
      visits: "2 visits a year",
      upcoming: [{ text: "May 1, 2027 · Scheduled", thisJob: false }, { text: "Nov 1, 2027 · Booked", thisJob: true }],
    });
    expect(membershipLines({ state: "member", planName: "P", startedAt: "2026-03-10T15:00:00.000Z", currentPeriodEnd: null, visitsPerYear: 0, upcoming: [] }, TZ).head).toBe("P · Member since Mar 2026");
    expect(membershipLines({ state: "none" }).head).toBe(SITE_COPY.notMember);
    expect(membershipLines({ state: "withheld" }).head).toBe(SITE_COPY.withheld);
  });
});

describe("siteCardLine (spec §7.6)", () => {
  it("counts, zero parts omitted", () => {
    expect(siteCardLine(view({ pastJobs: [job, job, job, job], openEstimates: [est()], membership: { state: "member", planName: "P", startedAt: "x", currentPeriodEnd: null, visitsPerYear: 1, upcoming: [] } }))).toEqual({
      text: "4 past jobs · 1 open estimate · Member", tappable: true,
    });
    expect(siteCardLine(view())).toEqual({ text: "No history at this address yet.", tappable: false });
  });
  it("no saved address, with this job's estimate; no customer", () => {
    expect(siteCardLine(view({ scope: "none", openEstimates: [est({ thisJob: true })] }))).toEqual({ text: "No saved address · 1 open estimate", tappable: true });
    expect(siteCardLine(view({ scope: "none" }))).toEqual({ text: "No saved address", tappable: false });
    expect(siteCardLine(view({ hasCustomer: false }))).toEqual({ text: "No customer on this job yet.", tappable: false });
  });
});
```

`src/lib/tech/photo-resize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pickPrepared, qualityFromStorage, resizePlan } from "./photo-resize";

const MB = 1024 * 1024;

describe("resizePlan (spec §7.7)", () => {
  it("standard: 1600/q0.8 → 1600/q0.7 → 1200/q0.7 → 900/q0.7 on the long edge", () => {
    expect(resizePlan("standard", 4032, 3024)).toEqual([
      { width: 1600, height: 1200, jpegQuality: 0.8 },
      { width: 1600, height: 1200, jpegQuality: 0.7 },
      { width: 1200, height: 900, jpegQuality: 0.7 },
      { width: 900, height: 675, jpegQuality: 0.7 },
    ]);
  });
  it("high: 3200/q0.9 → 3200/q0.8 → 2400/q0.7 → 1600/q0.7, portrait too", () => {
    expect(resizePlan("high", 3024, 4032).map((s) => [s.height, s.jpegQuality])).toEqual([[3200, 0.9], [3200, 0.8], [2400, 0.7], [1600, 0.7]]);
  });
  it("never upscales a small image", () => {
    expect(resizePlan("high", 800, 600)[0]).toEqual({ width: 800, height: 600, jpegQuality: 0.9 });
  });
});

describe("pickPrepared", () => {
  it("first step under 4 MB; none → too large; decode failure keeps a small original only", () => {
    expect(pickPrepared([5 * MB, 3 * MB, 1 * MB], 9 * MB)).toEqual({ kind: "step", index: 1 });
    expect(pickPrepared([5 * MB, 5 * MB], 9 * MB)).toEqual({ kind: "too_large" });
    expect(pickPrepared("decode_failed", 3 * MB)).toEqual({ kind: "original" });
    expect(pickPrepared("decode_failed", 5 * MB)).toEqual({ kind: "too_large" });
  });
});

describe("qualityFromStorage", () => {
  it("defaults to standard", () => {
    expect(qualityFromStorage(null)).toBe("standard");
    expect(qualityFromStorage("junk")).toBe("standard");
    expect(qualityFromStorage("high")).toBe("high");
  });
});
```

`src/lib/admin/request-forms-view.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { missingLine, reopenDescription, submissionChip, visitLabel, whoWhen } from "./request-forms-view";

describe("office Forms section copy (spec §7.5)", () => {
  it("visit label: ended or nothing", () => {
    expect(visitLabel({ appointmentNumber: 1, visitState: "live" })).toBe("Visit #1");
    expect(visitLabel({ appointmentNumber: 2, visitState: "ended" })).toBe("Visit #2 · ended");
  });
  it("chips", () => {
    expect(submissionChip({ erased: true, unreadable: false, status: "submitted" })).toBe("Answers removed");
    expect(submissionChip({ erased: false, unreadable: true, status: "draft" })).toBe("These answers can't be shown.");
    expect(submissionChip({ erased: false, unreadable: false, status: "submitted" })).toBe("Submitted");
    expect(submissionChip({ erased: false, unreadable: false, status: "draft" })).toBe("Draft");
  });
  it("who and when", () => {
    const at = "2026-11-07T19:41:00.000Z";
    expect(whoWhen({ status: "submitted", submittedAt: at, submittedByName: "Alex Rivera", updatedAt: at, updatedByName: null }, "America/New_York")).toBe("Submitted by Alex Rivera · Nov 7, 2:41 PM");
    expect(whoWhen({ status: "draft", submittedAt: null, submittedByName: null, updatedAt: at, updatedByName: "Sam Lee" }, "America/New_York")).toBe("Last saved by Sam Lee · Nov 7, 2:41 PM");
  });
  it("missing lines and the reopen confirm", () => {
    expect(missingLine("Maintenance checklist", "in_progress")).toEqual({ text: "Not submitted yet: Maintenance checklist", warning: false });
    expect(missingLine("Maintenance checklist", "completed")).toEqual({ text: "Required, not submitted: Maintenance checklist", warning: true });
    expect(reopenDescription(true)).toBe("The technician can change the answers and submit again.");
    expect(reopenDescription(false)).toBe("The technician can change the answers and submit again. No technician is on this visit any more.");
  });
});
```

`src/lib/tech/job-page-state.test.ts`:

```diff
diff --git a/src/lib/tech/job-page-state.test.ts b/src/lib/tech/job-page-state.test.ts
index fadbd19..25905a0 100644
--- a/src/lib/tech/job-page-state.test.ts
+++ b/src/lib/tech/job-page-state.test.ts
@@ -1,5 +1,5 @@
 import { describe, it, expect } from "vitest";
-import { JOB_NOT_FOUND, PHOTO_UPLOAD_FAILED, jobLoadOutcome } from "./job-page-state";
+import { JOB_NOT_FOUND, PHOTO_UPLOAD_FAILED, isImageMime, jobLoadOutcome } from "./job-page-state";
 
 describe("jobLoadOutcome", () => {
   it("2xx with success is ok", () => expect(jobLoadOutcome(200, true)).toBe("ok"));
@@ -18,6 +18,8 @@ describe("jobLoadOutcome", () => {
 describe("copy", () => {
   it("not found and photo failure lines", () => {
     expect(JOB_NOT_FOUND).toBe("This job isn't yours, or it no longer exists.");
-    expect(PHOTO_UPLOAD_FAILED).toBe("Couldn't upload that photo. Try again.");
+    expect(PHOTO_UPLOAD_FAILED).toBe("Couldn't upload that photo.");
+    expect(isImageMime("image/heic")).toBe(true);
+    expect(isImageMime("application/pdf")).toBe(false);
   });
 });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/tech/site-display.test.ts src/lib/tech/photo-resize.test.ts src/lib/admin/request-forms-view.test.ts src/lib/tech/job-page-state.test.ts`
Expected: FAIL — three modules unresolved; `PHOTO_UPLOAD_FAILED` still ends "Try again."; `isImageMime` missing.

- [ ] **Step 3: Pure modules.** `src/lib/tech/site-display.ts`:

```ts
/** Site page and Site card copy (M3d spec §7.6, §8). Pure, client-safe; dates in the business timezone. */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import { formatCentsExact } from "@/lib/admin/money-format";
import { plural } from "@/lib/format/plural";
import { statusLabel } from "@/lib/tech/job-display";
import type { SiteEstimate, SiteMembership, SitePastJob, SiteView } from "@/lib/tech/site-view";

const TZ = BUSINESS_BASE_LOCATION.timezone;
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).format(new Date(iso));

export const SITE_COPY = {
  noPastJobs: "No other jobs at this address.",
  noEstimates: "No open estimates.",
  noAddress: "This job has no saved address, so there's no site history.",
  noCustomer: "No customer on this job yet. Ask the office to add one.",
  notMember: "Not a member.",
  withheld: "Membership is on the customer's account. Ask the office.",
} as const;

/** "Nov 3, 2026 · Maintenance · Completed · Alex · Forms: Maintenance checklist" */
export function pastJobLine(j: SitePastJob, timeZone: string = TZ): string {
  const parts = [fmt(j.date, { month: "short", day: "numeric", year: "numeric" }, timeZone), j.kind, statusLabel(j.status)];
  if (j.leadTechnicianName) parts.push(j.leadTechnicianName);
  if (j.submittedFormNames.length > 0) parts.push(`Forms: ${j.submittedFormNames.join(", ")}`);
  return parts.join(" · ");
}

/** Spec §7.6: rows aren't links, except this job's open (native) estimates for the lead — to the M3c estimate page. */
export function estimateHref(jobId: string, e: Pick<SiteEstimate, "id" | "thisJob" | "fromFieldPulse">, isLead: boolean): string | null {
  return isLead && e.thisJob && !e.fromFieldPulse ? `/tech/jobs/${jobId}/estimates/${e.id}` : null;
}

/** "Up to $4,812.00" for several options, the exact total for one. */
export function estimateTotal(e: SiteEstimate): string {
  return e.optionCount > 1 ? `Up to ${formatCentsExact(e.totalCents)}` : formatCentsExact(e.totalCents);
}

export function unaddressedLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 earlier job has no saved address." : `${n} earlier jobs have no saved address.`;
}

export function membershipLines(m: SiteMembership, timeZone: string = TZ): { head: string; visits: string | null; upcoming: Array<{ text: string; thisJob: boolean }> } {
  if (m.state === "none") return { head: SITE_COPY.notMember, visits: null, upcoming: [] };
  if (m.state === "withheld") return { head: SITE_COPY.withheld, visits: null, upcoming: [] };
  const since = fmt(m.startedAt, { month: "short", year: "numeric" }, timeZone);
  const through = m.currentPeriodEnd ? ` · Paid through ${fmt(m.currentPeriodEnd, { month: "short", day: "numeric", year: "numeric" }, timeZone)}` : "";
  return {
    head: `${m.planName} · Member since ${since}${through}`,
    visits: m.visitsPerYear > 0 ? plural(m.visitsPerYear, "visit a year", "visits a year") : null,
    upcoming: m.upcoming.map((u) => ({
      text: `${fmt(u.dueDate, { month: "short", day: "numeric", year: "numeric" }, timeZone)} · ${u.status === "generated" ? "Booked" : "Scheduled"}`,
      thisJob: u.thisJob,
    })),
  };
}

/** The job page's Site card line, and whether it opens the Site page. */
export function siteCardLine(v: SiteView): { text: string; tappable: boolean } {
  if (!v.hasCustomer) return { text: "No customer on this job yet.", tappable: false };
  const thisJobEstimates = v.openEstimates.filter((e) => e.thisJob).length;
  if (v.scope === "none") {
    const est = thisJobEstimates > 0 ? ` · ${plural(thisJobEstimates, "open estimate", "open estimates")}` : "";
    return { text: `No saved address${est}`, tappable: thisJobEstimates > 0 || v.membership.state === "member" };
  }
  const parts: string[] = [];
  if (v.pastJobs.length > 0) parts.push(plural(v.pastJobs.length, "past job", "past jobs"));
  if (v.openEstimates.length > 0) parts.push(plural(v.openEstimates.length, "open estimate", "open estimates"));
  if (v.membership.state === "member") parts.push("Member");
  if (parts.length === 0) return { text: "No history at this address yet.", tappable: false };
  return { text: parts.join(" · "), tappable: true };
}
```

`src/lib/tech/photo-resize.ts`:

```ts
/**
 * Photo quality and resize plan (M3d spec §7.7). Pure: the browser adapter in
 * `photo-prepare.ts` draws each step; this decides the steps.
 */
import { TECH_UPLOAD_LIMIT_BYTES } from "@/lib/tech/upload-limits";

export type PhotoQuality = "standard" | "high";
export const QUALITY_STORAGE_KEY = "tech:photo-quality";

export interface ResizeStep {
  readonly maxEdge: number;
  readonly jpegQuality: number;
}

export const STEPS: Record<PhotoQuality, readonly ResizeStep[]> = {
  standard: [
    { maxEdge: 1600, jpegQuality: 0.8 },
    { maxEdge: 1600, jpegQuality: 0.7 },
    { maxEdge: 1200, jpegQuality: 0.7 },
    { maxEdge: 900, jpegQuality: 0.7 },
  ],
  high: [
    { maxEdge: 3200, jpegQuality: 0.9 },
    { maxEdge: 3200, jpegQuality: 0.8 },
    { maxEdge: 2400, jpegQuality: 0.7 },
    { maxEdge: 1600, jpegQuality: 0.7 },
  ],
};

export interface DrawStep {
  readonly width: number;
  readonly height: number;
  readonly jpegQuality: number;
}

/** The draw sizes for an image, never upscaling. */
export function resizePlan(quality: PhotoQuality, width: number, height: number): DrawStep[] {
  const longest = Math.max(width, height);
  return STEPS[quality].map((s) => {
    const scale = longest > s.maxEdge ? s.maxEdge / longest : 1;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), jpegQuality: s.jpegQuality };
  });
}

/** localStorage value → quality (default standard). */
export function qualityFromStorage(raw: string | null): PhotoQuality {
  return raw === "high" ? "high" : "standard";
}

export const fitsUpload = (bytes: number): boolean => bytes <= TECH_UPLOAD_LIMIT_BYTES;

export const PHOTO_CANT_PREPARE = "This photo can't be prepared on this phone. Take it again, or use a smaller photo.";

/** After every step: the first blob that fits; none fits → can't prepare. Decode failed → the original if it fits. */
export function pickPrepared(sizes: readonly number[] | "decode_failed", originalBytes: number): { kind: "step"; index: number } | { kind: "original" } | { kind: "too_large" } {
  if (sizes === "decode_failed") return fitsUpload(originalBytes) ? { kind: "original" } : { kind: "too_large" };
  const i = sizes.findIndex(fitsUpload);
  return i >= 0 ? { kind: "step", index: i } : { kind: "too_large" };
}
```

`src/lib/admin/request-forms-view.ts`:

```ts
/** Office Forms section copy (M3d spec §7.5). Pure, client-safe; dates in the business timezone. */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import type { OfficeSubmission } from "@/lib/admin/form-queries";

const TZ = BUSINESS_BASE_LOCATION.timezone;

export const REOPEN_TITLE = "Reopen this form?";
/** The dialog's description; with the title it reads as spec §7.5's sentence. */
export const REOPEN_COPY = "The technician can change the answers and submit again.";
export const REOPEN_NO_TECH = "No technician is on this visit any more.";
export const REOPEN_STALE = "Someone else changed this form. Reload to see the latest.";
export const UNREADABLE = "These answers can't be shown.";

export function visitLabel(s: Pick<OfficeSubmission, "appointmentNumber" | "visitState">): string {
  return `Visit #${s.appointmentNumber}${s.visitState === "ended" ? " · ended" : ""}`;
}

export function submissionChip(s: Pick<OfficeSubmission, "erased" | "unreadable" | "status">): string {
  if (s.erased) return "Answers removed";
  if (s.unreadable) return UNREADABLE;
  return s.status === "submitted" ? "Submitted" : "Draft";
}

const when = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/** "Submitted by Alex Rivera · Nov 7, 2:41 PM" / "Last saved by Sam Lee · Nov 7, 2:30 PM". */
export function whoWhen(s: Pick<OfficeSubmission, "status" | "submittedAt" | "submittedByName" | "updatedAt" | "updatedByName">, timeZone: string = TZ): string {
  if (s.status === "submitted" && s.submittedAt) return `Submitted by ${s.submittedByName ?? "a technician"} · ${when(s.submittedAt, timeZone)}`;
  return `Last saved by ${s.updatedByName ?? "a technician"} · ${when(s.updatedAt, timeZone)}`;
}

/** "Not submitted yet: <name>" on open requests; "Required, not submitted: <name>" (warning tone) on completed ones. */
export function missingLine(name: string, requestStatus: string): { text: string; warning: boolean } {
  return requestStatus === "completed"
    ? { text: `Required, not submitted: ${name}`, warning: true }
    : { text: `Not submitted yet: ${name}`, warning: false };
}

export function reopenDescription(visitHasTechnician: boolean): string {
  return visitHasTechnician ? REOPEN_COPY : `${REOPEN_COPY} ${REOPEN_NO_TECH}`;
}
```

```diff
diff --git a/src/lib/tech/job-page-state.ts b/src/lib/tech/job-page-state.ts
index ef11467..0858178 100644
--- a/src/lib/tech/job-page-state.ts
+++ b/src/lib/tech/job-page-state.ts
@@ -15,5 +15,10 @@ export function jobLoadOutcome(status: number | null, success: boolean): JobLoad
 export const JOB_NOT_FOUND = "This job isn't yours, or it no longer exists.";
 export const JOB_NOT_FOUND_BACK = "Back to my jobs";
 
-/** Any failed photo upload (server text is never shown). */
-export const PHOTO_UPLOAD_FAILED = "Couldn't upload that photo. Try again.";
+/** A failed upload (server text is never shown); the card offers Try again and Discard (M3d spec §7.7). */
+export const PHOTO_UPLOAD_FAILED = "Couldn't upload that photo.";
+export const FILE_UPLOAD_FAILED = "Couldn't upload that file.";
+export const UPLOAD_CUSTOMER_REMOVED = "This job's customer was removed.";
+
+/** Image rows render as thumbnails; anything else (PDFs) as a file tile. */
+export const isImageMime = (mime: string): boolean => mime.startsWith("image/");
```

- [ ] **Step 4: Run them to verify they pass**

Run: the Step 2 command. Expected: PASS (7 + 5 + 4 + the job-page-state file).

- [ ] **Step 5: Site card and page.** `src/components/tech/site/fetch-site.ts`:

```ts
import type { SiteView } from '@/lib/tech/site-view';

/** GET the Site view; never throws. */
export async function fetchSite(jobId: string): Promise<SiteView | null> {
  try {
    const res = await fetch(`/api/tech/jobs/${jobId}/site`);
    const body = await res.json().catch(() => null);
    return res.ok && body?.success ? (body.data as SiteView) : null;
  } catch {
    return null;
  }
}
```

`src/components/tech/site/site-card.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { siteCardLine } from '@/lib/tech/site-display';
import type { SiteView } from '@/lib/tech/site-view';
import { fetchSite } from './fetch-site';

/** The job page's Site card, after Forms (M3d spec §7.6). Not tappable when the page would be all empty. */
export function SiteCard({ jobId }: { readonly jobId: string }) {
  const [view, setView] = useState<SiteView | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetchSite(jobId).then((v) => {
      if (live) setView(v);
    });
    return () => {
      live = false;
    };
  }, [jobId]);

  if (view === null) return null; // a failed load hides the card; the page itself shows its error
  const line = view ? siteCardLine(view) : null;
  const body = (
    <span className="flex min-h-11 items-center gap-2 text-[15px]">
      <span className="flex-1">{line ? line.text : <Skeleton className="h-5 w-40" />}</span>
      {line?.tappable && <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />}
    </span>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">Site</CardTitle>
      </CardHeader>
      <CardContent>
        {line?.tappable ? <Link href={`/tech/jobs/${jobId}/site`} className="block active:bg-accent">{body}</Link> : body}
      </CardContent>
    </Card>
  );
}
```

`src/components/tech/site/site-page-client.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { estimateHref, estimateTotal, membershipLines, pastJobLine, SITE_COPY, unaddressedLine } from '@/lib/tech/site-display';
import type { SiteView } from '@/lib/tech/site-view';
import { fetchSite } from './fetch-site';

const CHIP = 'rounded-[3px] border px-1.5 py-0.5 text-[13px]';

/** What the technician should know about this address (M3d spec §7.6). Rows aren't links, except this job's open estimates for the lead. */
export function SitePageClient({ jobId }: { readonly jobId: string }) {
  const [view, setView] = useState<SiteView | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetchSite(jobId).then((v) => {
      if (live) setView(v);
    });
    return () => {
      live = false;
    };
  }, [jobId]);

  const back = (
    <Link href={`/tech/jobs/${jobId}`} className="inline-flex min-h-11 items-center gap-1.5 text-[15px] text-link">
      <ArrowLeft className="size-4" /> Back to job
    </Link>
  );
  if (view === undefined) return <div className="space-y-4">{back}<Skeleton className="h-48 w-full rounded-xl" /></div>;
  if (view === null) return <div className="space-y-4">{back}<p role="alert" className="text-[15px]">Couldn&apos;t load this site.</p></div>;

  const m = membershipLines(view.membership);
  const unaddressed = unaddressedLine(view.unaddressedCount);
  return (
    <div className="space-y-4">
      {back}
      <h1 className="text-[20px] font-semibold">{view.title}</h1>
      {!view.hasCustomer ? (
        <p className="text-[15px] text-muted-foreground">{SITE_COPY.noCustomer}</p>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-[17px]">At this address</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <section className="space-y-1.5">
                <h2 className="text-[15px] font-semibold">Past jobs</h2>
                {view.scope === 'none' ? (
                  <p className="text-[15px] text-muted-foreground">{SITE_COPY.noAddress}</p>
                ) : view.pastJobs.length === 0 ? (
                  <p className="text-[15px] text-muted-foreground">{SITE_COPY.noPastJobs}</p>
                ) : (
                  <ul className="space-y-1.5">{view.pastJobs.map((j) => <li key={j.id} className="text-[15px]">{pastJobLine(j)}</li>)}</ul>
                )}
                {unaddressed && <p className="text-[13px] text-muted-foreground">{unaddressed}</p>}
              </section>
              <section className="space-y-1.5">
                <h2 className="text-[15px] font-semibold">Open estimates</h2>
                {view.openEstimates.length === 0 ? (
                  <p className="text-[15px] text-muted-foreground">{SITE_COPY.noEstimates}</p>
                ) : (
                  <ul className="space-y-2">
                    {view.openEstimates.map((e) => {
                      const row = (
                        <span className="block space-y-0.5">
                          <span className="block text-[15px]">{e.label}</span>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[14px] tabular-nums">{estimateTotal(e)}</span>
                            {e.thisJob && <span className={CHIP}>This job</span>}
                            {e.fromFieldPulse && <span className={CHIP}>From FieldPulse</span>}
                          </span>
                        </span>
                      );
                      const href = estimateHref(jobId, e, view.isLead);
                      return (
                        <li key={e.id}>
                          {href ? <Link href={href} className="block min-h-11 active:bg-accent">{row}</Link> : row}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-[17px]">Membership</CardTitle></CardHeader>
            <CardContent className="space-y-1.5 text-[15px]">
              <p>{m.head}</p>
              {m.visits && <p className="text-muted-foreground">{m.visits}</p>}
              {view.membership.state === 'member' && (
                <>
                  <h2 className="pt-2 text-[15px] font-semibold">Upcoming maintenance</h2>
                  {m.upcoming.length === 0 ? (
                    <p className="text-muted-foreground">No visits due.</p>
                  ) : (
                    <ul className="space-y-1">
                      {m.upcoming.map((u) => (
                        <li key={u.text} className="flex flex-wrap items-center gap-1.5">
                          {u.text}{u.thisJob && <span className={CHIP}>This job</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
```

`src/app/tech/jobs/[id]/site/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { SitePageClient } from '@/components/tech/site/site-page-client';
import { isUuid } from '@/lib/validation/uuid';

/** The Site page (M3d spec §7.6), reached from the job page's Site card. Next.js 16: params is a Promise. */
export default async function TechSitePage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return <SitePageClient jobId={id} />;
}
```

In `src/components/tech/tech-job-detail-client.tsx` add `import { SiteCard } from '@/components/tech/site/site-card';` after the `FormsCard` import, and the card right after the Forms card:

```tsx
      <FormsCard jobId={id} visitId={formsVisit} summaryFailed={summaryFailed} refreshKey={refreshKey} onLoaded={setFormsView} />
      <SiteCard jobId={id} />
```

- [ ] **Step 6: Photos.** `src/lib/tech/photo-prepare.ts` (browser adapter; the plan is unit-tested, the drawing is checked on a real phone after deploy, spec §11):

```ts
/**
 * Browser adapter for photo resizing (M3d spec §7.7): decode through an
 * HTMLImageElement (`img.decode()` applies EXIF orientation when drawn), draw
 * straight at each planned size, encode JPEG, stop at the first blob that
 * fits. Re-encoding drops EXIF (GPS and capture time). Client-only.
 */
import { pickPrepared, resizePlan, type PhotoQuality } from "@/lib/tech/photo-resize";

export type Prepared = { readonly ok: true; readonly blob: Blob; readonly name: string } | { readonly ok: false };

function toJpeg(canvas: HTMLCanvasElement, q: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", q));
}

export async function preparePhoto(file: File, quality: PhotoQuality): Promise<Prepared> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      const pick = pickPrepared("decode_failed", file.size);
      return pick.kind === "original" ? { ok: true, blob: file, name: file.name } : { ok: false };
    }
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    for (const step of resizePlan(quality, img.naturalWidth, img.naturalHeight)) {
      const canvas = document.createElement("canvas");
      canvas.width = step.width;
      canvas.height = step.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { ok: false };
      ctx.drawImage(img, 0, 0, step.width, step.height);
      const blob = await toJpeg(canvas, step.jpegQuality);
      if (blob && pickPrepared([blob.size], file.size).kind === "step") return { ok: true, blob, name };
    }
    return { ok: false };
  } finally {
    URL.revokeObjectURL(url);
  }
}
```

Replace `src/components/tech/job-photos-card.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, FileText, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  FILE_UPLOAD_FAILED, PHOTO_UPLOAD_FAILED, UPLOAD_CUSTOMER_REMOVED, isImageMime,
} from '@/lib/tech/job-page-state';
import { PHOTO_CANT_PREPARE, QUALITY_STORAGE_KEY, qualityFromStorage, type PhotoQuality } from '@/lib/tech/photo-resize';
import { preparePhoto } from '@/lib/tech/photo-prepare';
import { FILE_TOO_LARGE_COPY, TECH_UPLOAD_LIMIT_BYTES } from '@/lib/tech/upload-limits';

interface PhotoRow {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: string;
  readonly url: string | null;
}

interface Failed {
  readonly blob: Blob;
  readonly name: string;
  readonly kind: 'photo' | 'file';
  readonly customerRemoved: boolean;
}

const QUALITY_LABEL: Record<PhotoQuality, string> = { standard: 'Standard', high: 'High' };

/**
 * Job photos and files (M3d spec §7.7): photos are resized on the phone to the
 * chosen quality (remembered per device), PDFs go up as they are, both at most
 * 4 MB. A failed upload keeps the prepared file for Try again or Discard.
 * `readOnly` (the summary hasn't loaded) shows the gallery only.
 */
export function JobPhotosCard({ jobId, readOnly }: { readonly jobId: string; readonly readOnly: boolean }) {
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ readonly text: string; readonly error: boolean } | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [quality, setQuality] = useState<PhotoQuality>('standard');
  const [qualityOpen, setQualityOpen] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      setQuality(qualityFromStorage(window.localStorage.getItem(QUALITY_STORAGE_KEY)));
    } catch {
      /* storage unavailable: standard */
    }
  }, []);

  const pickQuality = (q: PhotoQuality) => {
    setQuality(q);
    setQualityOpen(false);
    try {
      window.localStorage.setItem(QUALITY_STORAGE_KEY, q);
    } catch {
      /* storage unavailable: this session only */
    }
  };

  const loadPhotos = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/tech/jobs/${jobId}/photo`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) setPhotos(body.data.photos);
    } catch {
      /* non-critical: the gallery stays as it was */
    }
  }, [jobId]);

  useEffect(() => {
    void loadPhotos();
  }, [loadPhotos]);

  const upload = useCallback(async (blob: Blob, name: string, kind: 'photo' | 'file'): Promise<void> => {
    setUploading(true);
    setStatus(null);
    setFailed(null);
    try {
      const form = new FormData();
      form.append('file', blob, name);
      const res = await fetch(`/api/tech/jobs/${jobId}/photo`, { method: 'POST', body: form });
      if (res.ok) {
        setStatus({ text: kind === 'photo' ? 'Photo uploaded.' : 'File uploaded.', error: false });
        await loadPhotos();
        return;
      }
      const code = (await res.json().catch(() => null))?.error?.code;
      setFailed({ blob, name, kind, customerRemoved: code === 'CUSTOMER_REMOVED' });
    } catch {
      setFailed({ blob, name, kind, customerRemoved: false });
    } finally {
      setUploading(false);
    }
  }, [jobId, loadPhotos]);

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    const prepared = await preparePhoto(file, quality);
    setUploading(false);
    if (!prepared.ok) {
      setStatus({ text: PHOTO_CANT_PREPARE, error: true });
      return;
    }
    await upload(prepared.blob, prepared.name, 'photo');
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > TECH_UPLOAD_LIMIT_BYTES) {
      setStatus({ text: FILE_TOO_LARGE_COPY, error: true });
      return;
    }
    await upload(file, file.name, 'file');
  };

  const busy = uploading || failed !== null;
  const failedText = failed?.customerRemoved ? UPLOAD_CUSTOMER_REMOVED : failed?.kind === 'file' ? FILE_UPLOAD_FAILED : PHOTO_UPLOAD_FAILED;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">Photos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!readOnly && (
          <>
            <p className="flex items-center gap-2 text-[15px]">
              Quality: {QUALITY_LABEL[quality]} ·
              <button type="button" className="h-11 px-1 text-link" onClick={() => setQualityOpen((o) => !o)}>Change</button>
            </p>
            {qualityOpen && (
              <fieldset className="space-y-1">
                <legend className="text-[13px] text-muted-foreground">Standard saves data. High keeps more detail.</legend>
                {(['standard', 'high'] as const).map((q) => (
                  <label key={q} className="flex min-h-11 items-center gap-2 text-[15px]">
                    <input type="radio" name="photo-quality" checked={quality === q} onChange={() => pickQuality(q)} />
                    {QUALITY_LABEL[q]}
                  </label>
                ))}
              </fieldset>
            )}
            <input ref={photoRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" disabled={busy} onChange={(e) => void onPhoto(e)} />
            <input ref={fileRef} type="file" accept="application/pdf" className="sr-only" tabIndex={-1} aria-hidden="true" disabled={busy} onChange={(e) => void onFile(e)} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="h-11 rounded-xl px-4 text-[15px]" disabled={busy} onClick={() => photoRef.current?.click()}>
                <Camera className="size-4" aria-hidden="true" />
                {uploading ? 'Uploading…' : 'Take photo'}
              </Button>
              <Button type="button" variant="outline" className="h-11 rounded-xl px-4 text-[15px]" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Paperclip className="size-4" aria-hidden="true" /> Add file
              </Button>
            </div>
            {failed && (
              <div role="alert" className="space-y-2">
                <p className="text-[13px] text-danger-strong">{failedText}</p>
                <div className="flex gap-2">
                  {!failed.customerRemoved && (
                    <Button type="button" className="h-11 rounded-xl px-4 text-[15px]" disabled={uploading} onClick={() => void upload(failed.blob, failed.name, failed.kind)}>
                      Try again
                    </Button>
                  )}
                  <Button type="button" variant="outline" className="h-11 rounded-xl px-4 text-[15px]" disabled={uploading} onClick={() => setFailed(null)}>
                    Discard
                  </Button>
                </div>
              </div>
            )}
            {status && (
              <p role={status.error ? 'alert' : 'status'} className={`text-[13px] ${status.error ? 'text-danger-strong' : 'text-muted-foreground'}`}>
                {status.text}
              </p>
            )}
          </>
        )}
        {photos.length === 0 ? (
          <p className="text-[15px] text-muted-foreground">No photos yet.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {photos.map((p) =>
              p.url && isImageMime(p.mimeType) ? (
                <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url} alt={p.filename} className="aspect-square w-full rounded-md border border-border object-cover" />
                </a>
              ) : p.url ? (
                <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-md border border-border p-1 text-center text-[11px] text-muted-foreground">
                  <FileText className="size-5" aria-hidden="true" />
                  <span className="line-clamp-2 break-all">{p.filename}</span>
                </a>
              ) : (
                <div key={p.id} className="flex aspect-square w-full items-center justify-center rounded-md border border-border text-[11px] text-muted-foreground">
                  {p.filename}
                </div>
              ),
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 7: Office Forms section.** `src/components/admin/request-forms-section.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionCard } from '@/components/admin/ui/section-card';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { cn } from '@/lib/utils';
import { answerText } from '@/lib/forms/form-values';
import type { OfficeSubmission, RequestForms } from '@/lib/admin/form-queries';
import {
  missingLine, REOPEN_STALE, REOPEN_TITLE, reopenDescription, submissionChip, visitLabel, whoWhen,
} from '@/lib/admin/request-forms-view';

/**
 * The request detail sheet's Forms section, after Visits (M3d spec §7.5): each
 * submission with its answers (range notes included), the required forms not
 * submitted yet, and Reopen for submitted ones. `refreshKey` reloads it.
 */
export function RequestFormsSection({
  requestId,
  requestStatus,
  refreshKey,
}: {
  readonly requestId: string;
  readonly requestStatus: string;
  readonly refreshKey: string;
}) {
  const [data, setData] = useState<RequestForms | null>(null);
  const [failed, setFailed] = useState(false);
  const [target, setTarget] = useState<OfficeSubmission | null>(null);
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/requests/${requestId}/forms`);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) {
        setData(body.data as RequestForms);
        setFailed(false);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function reopen(): Promise<void> {
    if (!target) return;
    setReopening(true);
    setReopenError(null);
    try {
      const res = await fetch(`/api/admin/requests/${requestId}/forms/${target.id}/reopen`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: target.revision }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        setTarget(null);
        await load();
      } else {
        setReopenError(body?.error?.code === 'STALE' ? REOPEN_STALE : "Couldn't reopen the form. Please try again.");
      }
    } catch {
      setReopenError("Couldn't reopen the form. Please try again.");
    } finally {
      setReopening(false);
    }
  }

  if (data === null && !failed) {
    return (
      <SectionCard title="Forms" icon={ListChecks}>
        <div className="space-y-2 p-4"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
      </SectionCard>
    );
  }
  if (data === null) {
    return (
      <SectionCard title="Forms" icon={ListChecks}>
        <p role="alert" className="p-4 text-sm text-destructive">
          Couldn&apos;t load forms.{' '}
          <button type="button" className="underline" onClick={() => void load()}>Try again</button>
        </p>
      </SectionCard>
    );
  }
  if (data.submissions.length === 0 && data.missingRequired.length === 0) return null;

  return (
    <>
      <SectionCard title="Forms" icon={ListChecks} count={data.submissions.length}>
        {data.missingRequired.length > 0 && (
          <ul className="space-y-1 border-b px-4 py-2.5 text-sm">
            {data.missingRequired.map((m) => {
              const line = missingLine(m.name, requestStatus);
              return <li key={m.formId} className={cn(line.warning && 'text-warning-strong')}>{line.text}</li>;
            })}
          </ul>
        )}
        <ul className="divide-y">
          {data.submissions.map((s) => (
            <li key={s.id} className="space-y-2 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.formName}</span>
                <span className="text-muted-foreground">{visitLabel(s)}</span>
                <span className="rounded-[3px] border px-1.5 py-0.5 text-xs">{submissionChip(s)}</span>
                {s.status === 'submitted' && !s.erased && (
                  <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={() => { setReopenError(null); setTarget(s); }}>
                    Reopen
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{whoWhen(s)}</p>
              {s.values && (
                <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  {s.fields.map((f) =>
                    f.type === 'heading' ? (
                      <dt key={f.id} className="pt-1 font-medium sm:col-span-2">{f.label}</dt>
                    ) : (
                      <div key={f.id} className="contents">
                        <dt className="text-muted-foreground">{f.label}</dt>
                        <dd>{answerText(f, s.values?.[f.id])}</dd>
                      </div>
                    ),
                  )}
                </dl>
              )}
            </li>
          ))}
        </ul>
      </SectionCard>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => { if (!o) setTarget(null); }}
        title={REOPEN_TITLE}
        description={reopenDescription(target?.visitHasTechnician ?? true)}
        confirmLabel="Reopen"
        isConfirming={reopening}
        error={reopenError}
        onConfirm={() => void reopen()}
      />
    </>
  );
}
```

`src/components/admin/request-detail-sheet.tsx` (re-read first; the section goes after `VisitsSection`):

```diff
diff --git a/src/components/admin/request-detail-sheet.tsx b/src/components/admin/request-detail-sheet.tsx
index 6d8eddb..fa0d18b 100644
--- a/src/components/admin/request-detail-sheet.tsx
+++ b/src/components/admin/request-detail-sheet.tsx
@@ -25,6 +25,7 @@ import { StatusBadge } from '@/components/admin/status-badge';
 import { ScopedEstimatesSection } from '@/components/admin/estimates/scoped-estimates-section';
 import { ScopedInvoicesSection } from '@/components/admin/invoices/scoped-invoices-section';
 import { AttachmentsSection } from '@/components/admin/attachments-section';
+import { RequestFormsSection } from '@/components/admin/request-forms-section';
 import {
   allowedTransitions,
   MANUAL_TARGET_STATUSES,
@@ -1159,6 +1160,13 @@ export function RequestDetailSheet({
                 }}
               />
 
+              <RequestFormsSection
+                key={`forms-${detail.id}`}
+                requestId={detail.id}
+                requestStatus={detail.status}
+                refreshKey={[detail.status, detail.currentVisit.kind].join('|')}
+              />
+
               <section>
                 <h3 className="text-sm font-semibold mb-2">Tags</h3>
                 <TagChipPicker entity="job" entityId={detail.id} />
```

- [ ] **Step 8: Walk it (390×844 and 1440).** Dev server running. `walk-m3d-11.mts` at the repo root:

```ts
/**
 * Task 11 walk: the job page's Site card and Site page (390×844), the photo
 * quality line, then the office request sheet's Forms section with the range
 * note and Reopen (1440), and "Answers removed" after erasing customer A.
 * Photo upload itself can't run on dev (no R2). Deleted before commit.
 */
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const env = { ...process.env, NODE_OPTIONS: "--conditions=react-server" };
const fx = JSON.parse(execFileSync("npx", ["tsx", "scripts/agent/m3d-walk.mts", "seed"], { encoding: "utf8", env }).trim().split("\n").pop()!) as {
  org: string; job: string; visit: string; synced: string; custA: string; past1: string; past2: string; otherJob: string;
  tokens: { admin: string; lead: string };
};
const BASE = "http://localhost:3000";
const adminHeaders = { "content-type": "application/json", cookie: `hvac_admin_session=${fx.tokens.admin}`, origin: BASE };
const techHeaders = { "content-type": "application/json", cookie: `hvac_tech_session=${fx.tokens.lead}`, origin: BASE };
const browser = await chromium.launch();
try {
  const created = await (await fetch(`${BASE}/api/admin/settings/forms`, {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({
      clientToken: crypto.randomUUID(), name: "Maintenance checklist", description: null, jobTypeIds: [], required: true,
      fields: [
        { id: "f_walk000001", type: "checkbox", label: "Filter changed", required: true },
        { id: "f_walk000005", type: "number", label: "Suction pressure", required: false, unit: "psi", usualMin: 100, usualMax: 140 },
      ],
    }),
  })).json();
  const formId = created.data.id as string;
  const put = await fetch(`${BASE}/api/tech/jobs/${fx.job}/forms/${formId}/draft`, {
    method: "PUT", headers: techHeaders,
    body: JSON.stringify({ appointmentId: fx.visit, formVersion: 1, baseRevision: 0, saveId: crypto.randomUUID(), changes: { f_walk000001: true, f_walk000005: 180 } }),
  });
  if (put.status !== 201) throw new Error(`draft ${put.status}`);
  const sub = await fetch(`${BASE}/api/tech/jobs/${fx.job}/forms/${formId}/submit`, {
    method: "POST", headers: { ...techHeaders, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ appointmentId: fx.visit, formVersion: 1, baseRevision: 1, changes: {} }),
  });
  if (sub.status !== 200) throw new Error(`submit ${sub.status}`);

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  await phone.addCookies([{ name: "hvac_tech_session", value: fx.tokens.lead, domain: "localhost", path: "/" }]);
  const tech = await phone.newPage();
  await tech.goto(`${BASE}/tech/jobs/${fx.job}`);
  await tech.getByText("2 past jobs · 1 open estimate · Member").waitFor();
  await tech.getByText("Quality: Standard ·").waitFor();
  await tech.getByRole("button", { name: "Change" }).click();
  await tech.getByLabel("High").check();
  await tech.getByText("Quality: High ·").waitFor();
  await tech.screenshot({ path: "/tmp/m3d-11-job.png", fullPage: true });
  await tech.getByText("2 past jobs · 1 open estimate · Member").click();
  await tech.getByText("At this address").waitFor();
  await tech.getByText("Comfort Club · Member since").waitFor();
  if (await tech.getByText("Bristol").count()) throw new Error("another customer's address leaked");
  await tech.screenshot({ path: "/tmp/m3d-11-site.png", fullPage: true });
  await tech.goto(`${BASE}/tech/jobs/${fx.synced}/site`);
  await tech.getByText("This job has no saved address, so there's no site history.").waitFor();

  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await desk.addCookies([{ name: "hvac_admin_session", value: fx.tokens.admin, domain: "localhost", path: "/" }]);
  const office = await desk.newPage();
  await office.goto(`${BASE}/admin/requests?request=${fx.job}`);
  await office.getByText("180 psi · Outside the usual range (100–140 psi)").waitFor();
  await office.screenshot({ path: "/tmp/m3d-11-office.png", fullPage: true });
  await office.getByRole("button", { name: "Reopen" }).click();
  await office.getByText("The technician can change the answers and submit again.").waitFor();
  await office.getByRole("button", { name: "Reopen" }).last().click();
  await office.getByText("Draft", { exact: true }).waitFor();
  await office.screenshot({ path: "/tmp/m3d-11-reopened.png", fullPage: true });
  const erase = await fetch(`${BASE}/api/admin/customers/${fx.custA}/erase`, { method: "POST", headers: adminHeaders, body: "{}" });
  if (!erase.ok) throw new Error(`erase ${erase.status}`);
  await office.reload();
  await office.getByText("Answers removed").waitFor();
  await office.screenshot({ path: "/tmp/m3d-11-erased.png", fullPage: true });
  console.log(JSON.stringify({ ok: true, org: fx.org }));
} finally {
  await browser.close();
  execFileSync("npx", ["tsx", "scripts/agent/m3d-walk.mts", "delete", fx.org], { encoding: "utf8", env, stdio: "inherit" });
}
```

Run `npx tsx walk-m3d-11.mts`. Expected `{"ok":true,…}` and the org deleted. Look at: `/tmp/m3d-11-reopened.png` (`Draft` after the Reopen confirm whose description reads "The technician can change the answers and submit again."), `/tmp/m3d-11-job.png` (Site card "2 past jobs · 1 open estimate · Member" after Forms; Photos "Quality: High · Change", `Take photo` and `Add file`), `/tmp/m3d-11-site.png` ("At this address", A's two past jobs — none of B's "Bristol" job —, the estimate "Up to $4,812.00" (a link: the walk's session is the lead; a helper's session shows it as plain text), "Comfort Club · Member since … · Paid through …", "2 visits a year", one upcoming visit), `/tmp/m3d-11-office.png` (Forms section after Visits: "Visit #1", `Submitted`, "Suction pressure 180 psi · Outside the usual range (100–140 psi)", `Reopen`), `/tmp/m3d-11-erased.png` ("Answers removed", no answers). Photo upload cannot run on dev (no R2 write credentials, `page-tech` gotchas): the 4 MB, uuid and erased-customer paths are the Task 6 route tests. Delete the walk script.

- [ ] **Step 9: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/tech/site-display.ts src/lib/tech/site-display.test.ts src/components/tech/site "src/app/tech/jobs/[id]/site" src/lib/tech/photo-resize.ts src/lib/tech/photo-resize.test.ts src/lib/tech/photo-prepare.ts src/components/tech/job-photos-card.tsx src/lib/tech/job-page-state.ts src/lib/tech/job-page-state.test.ts src/lib/admin/request-forms-view.ts src/lib/admin/request-forms-view.test.ts src/components/admin/request-forms-section.tsx src/components/admin/request-detail-sheet.tsx src/components/tech/tech-job-detail-client.tsx && npx vitest run
git add src/lib/tech/site-display.ts src/lib/tech/site-display.test.ts src/components/tech/site/fetch-site.ts src/components/tech/site/site-card.tsx src/components/tech/site/site-page-client.tsx "src/app/tech/jobs/[id]/site/page.tsx" src/lib/tech/photo-resize.ts src/lib/tech/photo-resize.test.ts src/lib/tech/photo-prepare.ts src/components/tech/job-photos-card.tsx src/lib/tech/job-page-state.ts src/lib/tech/job-page-state.test.ts src/lib/admin/request-forms-view.ts src/lib/admin/request-forms-view.test.ts src/components/admin/request-forms-section.tsx src/components/admin/request-detail-sheet.tsx src/components/tech/tech-job-detail-client.tsx
git commit -m "$(cat <<'EOF'
feat(m3d): Site card and page, photo quality + resize + PDF files, office Forms section with reopen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 12: Integration suite (a)–(n) on the dev DB, then docs

**Files:**
- Create: `tests/integration/field-forms.test.ts`
- Modify: `vitest.config.ts` (append one line to `INTEGRATION_SUITES`; re-read right before the edit), `.claude/skills/page-tech/SKILL.md`, `.claude/skills/page-settings/SKILL.md`, `.claude/skills/page-requests/SKILL.md`, `.claude/skills/page-customers/SKILL.md`, `replica/features.csv` (lines 122, 125, 126, 131), `replica/parity.md` (regenerated), `replica/build-log.md`, `replica/architecture.md` (the M3d paragraph ~line 609 and the M3d API row ~line 244), memory `/Users/sizbei/.claude/projects/-Users-sizbei-Documents-GitHub-ai-hvac-agent/memory/replica-program-fp-st.md` (not committed: outside the repo)

**Interfaces:**
- Consumes: everything above; the writers are driven directly and the submit route's run body is mirrored by `submitVia`.
- Produces: the suite; docs.

- [ ] **Step 1: Write the suite** — `tests/integration/field-forms.test.ts` (two throwaway orgs plus one purge org; every fixture UPDATE by id AND organization_id; v4.1's three cascade checks are in (g) and (g2)):

```ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The erase's R2 cleanup runs in after(): capture it instead of needing a request scope.
const afterCallbacks: Array<() => unknown> = [];
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
}));
const deletedKeys: string[] = [];
vi.mock("@/lib/storage/r2-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/r2-client")>()),
  getStorageClient: () => ({
    deleteFile: async (key: string) => {
      deletedKeys.push(key);
    },
  }),
}));

/**
 * Field forms integration suite (M3d spec §9 (a)–(n), v4.1) against the DEV
 * database (`VITEST_INTEGRATION=1`). Drives the writers exactly as the routes
 * do (`submitVia` mirrors the submit route's run body), never HTTP. Two
 * throwaway orgs via createOrgCore (the second for tenancy), deleted in
 * afterAll even on failure. Fixture UPDATEs are by id AND organization_id. No
 * customer phone is ever set; nothing queues a message.
 */

type FW = typeof import("@/lib/tech/form-writes");
type FQ = typeof import("@/lib/admin/form-queries");
type FR = typeof import("@/lib/tech/form-reads");
type SQ = typeof import("@/lib/tech/site-queries");
type ID = typeof import("@/lib/http/idempotency");
type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;
type RunOut = Awaited<ReturnType<ID["withIdempotency"]>>;
type FormDef = import("@/lib/forms/form-schema").FormDefinition;
type Changes = import("@/lib/forms/form-values").Changes;

let fw: FW; let fq: FQ; let fr: FR; let sq: SQ; let idem: ID;
let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let encrypt: typeof import("@/lib/crypto").encrypt;
let okResult: typeof import("@/lib/tech/invoice-write-route").okResult;
let formReasonResult: typeof import("@/lib/tech/form-errors").formReasonResult;
let submitHashInput: typeof import("@/lib/tech/form-submit-hash").submitHashInput;
let anonymizeCustomer: typeof import("@/lib/admin/erasure-queries").anonymizeCustomer;
let deleteCustomer: typeof import("@/lib/admin/crm-queries").deleteCustomer;
let addJobPhoto: typeof import("@/lib/tech/photo-writes").addJobPhoto;
let runBatch: typeof import("@/lib/admin/invoice-field-writes").runBatch;
let lockRequestSql: typeof import("@/lib/admin/invoice-field-writes").lockRequestSql;
let carryForNewVersion: typeof import("@/lib/tech/form-fill-state").carryForNewVersion;
let mergeDraft: typeof import("@/lib/forms/form-values").mergeDraft;

let org = "";
let org2 = "";
let admin = "";
let lead = "";
let helper = "";
let jobType = "";

const SECRET = "Gate code 4471 behind the shed";
const F = {
  a: "f_aaaaaaaaa1", b: "f_aaaaaaaaa2", c: "f_aaaaaaaaa3", d: "f_aaaaaaaaa4", psi: "f_aaaaaaaaa5", note: "f_aaaaaaaaa6",
} as const;

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
}

/** 4 checkboxes (2 required) + a psi number with a usual range + a long answer. */
function checklist(name = `Maintenance checklist ${randomUUID().slice(0, 6)}`, over: Partial<FormDef> = {}): FormDef {
  return {
    name, description: null, jobTypeIds: [], required: true,
    fields: [
      { id: F.a, type: "checkbox", label: "Filter changed", required: true },
      { id: F.b, type: "checkbox", label: "Coil cleaned", required: true },
      { id: F.c, type: "checkbox", label: "Drain flushed", required: false },
      { id: F.d, type: "checkbox", label: "Thermostat checked", required: false },
      { id: F.psi, type: "number", label: "Suction pressure", required: false, unit: "psi", usualMin: 100, usualMax: 140 },
      { id: F.note, type: "long_text", label: "Findings", required: false },
    ],
    ...over,
  };
}

async function newForm(def: FormDef = checklist()): Promise<string> {
  const r = await fq.createForm(org, admin, randomUUID(), def);
  if (!r.ok) throw new Error(r.reason);
  return r.id;
}

async function newTech(name: string): Promise<string> {
  return (await run(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
    VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example',${name},'technician','x',true) RETURNING id`))[0]!.id as string;
}

async function newCustomer(): Promise<string> {
  return (await run(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},${encrypt("Pat Probe")}) RETURNING id`))[0]!.id as string;
}

/** A request assigned to `lead` (the trigger makes visit #1 + the lead row). */
async function newJob(o: {
  status?: string; customerId?: string | null; fieldpulse?: boolean; address?: string | null; locationId?: string | null;
  jobTypeId?: string | null; scheduled?: boolean;
} = {}): Promise<string> {
  const sess = (await run(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`))[0]!.id as string;
  return (await run(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,customer_id,location_id,job_type_id,issue_type,urgency,description,reference_number,scheduled_date,status,fieldpulse_job_id,address_encrypted)
    VALUES (${org},${sess},${lead},${o.customerId ?? null},${o.locationId ?? null},${o.jobTypeId ?? null},'no_heat','medium','Form probe','FRM-'||substr(md5(random()::text),1,8),
      ${o.scheduled === false ? null : new Date().toISOString()}::timestamptz,${o.status ?? "arrived"}::request_status,
      ${o.fieldpulse ? `fp-${randomUUID().slice(0, 8)}` : null},${o.address ? encrypt(o.address) : null})
    RETURNING id`))[0]!.id as string;
}

async function visitOf(rid: string, n = 1): Promise<string> {
  return (await run(sql`SELECT id FROM appointments WHERE service_request_id = ${rid} AND organization_id = ${org} AND appointment_number = ${n}`))[0]!.id as string;
}

async function addVisit(rid: string, n: number): Promise<string> {
  return (await run(sql`INSERT INTO appointments (organization_id,service_request_id,appointment_number,scheduled_date) VALUES (${org},${rid},${n},now()) RETURNING id`))[0]!.id as string;
}

async function assign(aid: string, tech: string, o: { arrived?: boolean; lead?: boolean } = {}): Promise<void> {
  await run(sql`INSERT INTO appointment_assignments (organization_id,appointment_id,technician_id,is_lead,status,arrived_at)
    VALUES (${org},${aid},${tech},${o.lead ?? false},${o.arrived ? "arrived" : "assigned"}::request_status,${o.arrived ? new Date().toISOString() : null}::timestamptz)
    ON CONFLICT (appointment_id, technician_id) DO UPDATE SET status = EXCLUDED.status, arrived_at = EXCLUDED.arrived_at`);
}

const actor = (rid: string, me = lead) => ({ organizationId: org, requestId: rid, techUserId: me });

function draft(rid: string, aid: string, formId: string, changes: Changes, o: { me?: string; base?: number; version?: number; saveId?: string } = {}) {
  return fw.saveFormDraft(actor(rid, o.me), {
    formId, appointmentId: aid, formVersion: o.version ?? 1, baseRevision: o.base ?? 0, saveId: o.saveId ?? randomUUID(), changes,
  });
}

/** The submit route's run body. */
function submitVia(rid: string, aid: string, formId: string, key: string, changes: Changes, o: { me?: string; base?: number; version?: number } = {}): Promise<RunOut> {
  const me = o.me ?? lead;
  const body = { appointmentId: aid, formVersion: o.version ?? 1, baseRevision: o.base ?? 0, changes };
  const scope = { organizationId: org, userId: me, route: `/api/tech/jobs/${rid}/forms/${formId}/submit`, key };
  return idem.withIdempotency(scope, idem.canonicalHash(submitHashInput(body)), async (ids) => {
    const r = await fw.submitForm(actor(rid, me), { ...body, formId }, { submitKey: ids.id("form-submit") });
    if (!r.ok) return formReasonResult(r);
    return okResult(200, { submissionId: r.submissionId, revision: r.revision, submittedAt: r.submittedAt });
  });
}

const code = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);
const envCode = (r: RunOut): string | undefined => (r.envelope.success ? undefined : r.envelope.error.code);
const ALL_REQUIRED: Changes = { [F.a]: true, [F.b]: true };

async function row(rid: string, aid: string, formId: string): Promise<Row | undefined> {
  return (await run(sql`SELECT * FROM form_submissions WHERE organization_id = ${org} AND service_request_id = ${rid} AND appointment_id = ${aid} AND form_id = ${formId}`))[0];
}
async function auditCount(action: string, entityId: string): Promise<number> {
  return Number((await run(sql`SELECT count(*)::int AS n FROM audit_log WHERE organization_id = ${org} AND action = ${action} AND entity_id = ${entityId}`))[0]!.n);
}
async function techView(rid: string, formId: string, aid: string, me = lead) {
  const r = await fr.getJobForm(org, me, rid, formId, aid);
  if (r.kind !== "ok") throw new Error(`view ${r.kind}`);
  return r.view;
}

beforeAll(async () => {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.includes("ep-withered-hill")) throw new Error("Refusing to run against the production database");

  ({ sql } = await import("drizzle-orm"));
  ({ db } = await import("@/lib/db"));
  ({ encrypt } = await import("@/lib/crypto"));
  fw = await import("@/lib/tech/form-writes");
  fq = await import("@/lib/admin/form-queries");
  fr = await import("@/lib/tech/form-reads");
  sq = await import("@/lib/tech/site-queries");
  idem = await import("@/lib/http/idempotency");
  ({ okResult } = await import("@/lib/tech/invoice-write-route"));
  ({ formReasonResult } = await import("@/lib/tech/form-errors"));
  ({ submitHashInput } = await import("@/lib/tech/form-submit-hash"));
  ({ anonymizeCustomer } = await import("@/lib/admin/erasure-queries"));
  ({ deleteCustomer } = await import("@/lib/admin/crm-queries"));
  ({ addJobPhoto } = await import("@/lib/tech/photo-writes"));
  ({ carryForNewVersion } = await import("@/lib/tech/form-fill-state"));
  ({ runBatch, lockRequestSql } = await import("@/lib/admin/invoice-field-writes"));
  ({ mergeDraft } = await import("@/lib/forms/form-values"));
  const { createOrgCore } = await import("@/lib/admin/provisioning");

  const mkOrg = async (label: string) => {
    const out = await createOrgCore({
      name: `Probe Org Field Forms ${label} ${randomUUID().slice(0, 8)}`,
      createdBy: null,
      ownerEmail: null,
      ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
      skipOrgCountCheck: true,
    });
    if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
    return out.result;
  };
  const a = await mkOrg("A");
  org = a.organizationId;
  admin = a.ownerUserId!;
  org2 = (await mkOrg("B")).organizationId;
  lead = await newTech("Alex Rivera");
  helper = await newTech("Sam Lee");
  jobType = (await run(sql`SELECT id FROM job_types WHERE organization_id = ${org} ORDER BY position LIMIT 1`))[0]!.id as string;
}, 90_000);

afterAll(async () => {
  for (const id of [org, org2].filter(Boolean)) {
    try {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${id}`);
    } catch (error) {
      console.error(`afterAll: could not delete probe org ${id}`, error);
    }
  }
}, 60_000);

describe("field forms (dev DB)", () => {
  it("(a) createForm twice with one token → one row; empty definition refused; stale PATCH; duplicate name", async () => {
    const token = randomUUID();
    const def = checklist();
    const one = await fq.createForm(org, admin, token, def);
    const two = await fq.createForm(org, admin, token, def);
    expect(one).toMatchObject({ ok: true, created: true });
    expect(two).toMatchObject({ ok: true, created: false });
    if (!one.ok || !two.ok) return;
    expect(two.id).toBe(one.id);
    expect(Number((await run(sql`SELECT count(*)::int AS n FROM forms WHERE organization_id = ${org} AND name = ${def.name}`))[0]!.n)).toBe(1);

    // An empty definition (headings only) is refused by the route's schema before any write: no row.
    const { formDefinitionSchema } = await import("@/lib/forms/form-schema");
    const countForms = async () => Number((await run(sql`SELECT count(*)::int AS n FROM forms WHERE organization_id = ${org}`))[0]!.n);
    const before = await countForms();
    expect(formDefinitionSchema.safeParse({ ...def, fields: [{ id: F.a, type: "heading", label: "H", required: false }] }).success).toBe(false);
    expect(await countForms()).toBe(before);

    expect(await fq.updateForm(org, one.id, { version: 1, definition: { ...def, required: false } })).toEqual({ ok: true, version: 2 });
    expect(await fq.updateForm(org, one.id, { version: 1, definition: def })).toEqual({ ok: false, reason: "stale" });
    expect(await fq.createForm(org, admin, randomUUID(), { ...def, name: def.name.toUpperCase() })).toEqual({ ok: false, reason: "name_taken" });
  }, 60_000);

  it("(b) done-when: helper saves, reload shows the draft, replays, untick after a lost tick, FORM_INCOMPLETE, submit, replays", async () => {
    const formId = await newForm();
    const rid = await newJob({ status: "scheduled" });
    const v1 = await visitOf(rid);
    await assign(v1, helper, { arrived: true });

    const save1 = randomUUID();
    const s1 = await draft(rid, v1, formId, { [F.a]: true, [F.c]: true, [F.psi]: 180 }, { me: helper, saveId: save1 });
    expect(s1).toMatchObject({ ok: true, revision: 1, created: true });
    const view = await techView(rid, formId, v1, helper);
    expect(view.submission?.values).toEqual({ [F.a]: true, [F.c]: true, [F.psi]: 180 });
    expect(view.canWrite).toBe(true);

    // The same saveId again → replay.
    expect(await draft(rid, v1, formId, { [F.a]: true, [F.c]: true, [F.psi]: 180 }, { me: helper, saveId: save1 })).toMatchObject({ ok: true, revision: 1, created: false });
    // A colleague's long answer, then a replay: the helper's next save lands and its retry is still a replay
    // (checked before any decrypt, apply or measure). No valid form reaches the 128 KB cap (lead ruling 5).
    await assign(v1, lead, { arrived: true });
    expect(await draft(rid, v1, formId, { [F.note]: "€".repeat(2000) }, { base: 1 })).toMatchObject({ ok: true, revision: 2 });
    const save2 = randomUUID();
    expect(await draft(rid, v1, formId, { [F.psi]: 120 }, { me: helper, base: 2, saveId: save2 })).toMatchObject({ ok: true, revision: 3 });
    expect(await draft(rid, v1, formId, { [F.psi]: 120 }, { me: helper, base: 2, saveId: save2 })).toMatchObject({ ok: true, revision: 3, created: false });
    // A stale retry of the first save is STALE, not a replay.
    expect(await draft(rid, v1, formId, { [F.a]: true, [F.c]: true, [F.psi]: 180 }, { me: helper, saveId: save1 })).toMatchObject({ ok: false, reason: "stale", revision: 3 });

    // Tick (response lost), untick, retry the first then the second → unticked.
    const tick = randomUUID();
    const untick = randomUUID();
    expect(await draft(rid, v1, formId, { [F.d]: true }, { me: helper, base: 3, saveId: tick })).toMatchObject({ ok: true, revision: 4 });
    expect(await draft(rid, v1, formId, { [F.d]: true }, { me: helper, base: 3, saveId: tick })).toMatchObject({ ok: true, revision: 4 });
    expect(await draft(rid, v1, formId, { [F.d]: null }, { me: helper, base: 4, saveId: untick })).toMatchObject({ ok: true, revision: 5 });
    expect(await draft(rid, v1, formId, { [F.d]: null }, { me: helper, base: 4, saveId: untick })).toMatchObject({ ok: true, revision: 5 });
    expect((await techView(rid, formId, v1, helper)).submission?.values?.[F.d]).toBeUndefined();

    const key1 = randomUUID();
    const missing = await submitVia(rid, v1, formId, key1, {}, { me: helper, base: 5 });
    expect([missing.status, envCode(missing)]).toEqual([400, "FORM_INCOMPLETE"]);
    const key2 = randomUUID();
    const done = await submitVia(rid, v1, formId, key2, ALL_REQUIRED, { me: helper, base: 5 });
    expect(done.status).toBe(200);
    const r = await row(rid, v1, formId);
    expect(r).toMatchObject({ status: "submitted", submitted_by: helper });
    expect(await auditCount("form_submitted", String(r!.id))).toBe(1);

    const again = await submitVia(rid, v1, formId, key2, ALL_REQUIRED, { me: helper, base: 5 });
    expect([again.status, again.replayed]).toEqual([200, true]);
    expect(envCode(await submitVia(rid, v1, formId, randomUUID(), ALL_REQUIRED, { me: helper, base: 6 }))).toBe("FORM_SUBMITTED");
    expect(await draft(rid, v1, formId, { [F.c]: null }, { me: helper, base: 6 })).toMatchObject({ ok: false, reason: "form_submitted" });
    expect(await auditCount("form_submitted", String(r!.id))).toBe(1);
  }, 90_000);

  it("(c) submit takeover → 200 and one audit row; submit, reopen, resubmit → two; a first insert whose update misses → no audit", async () => {
    const formId = await newForm();
    const rid = await newJob();
    const v1 = await visitOf(rid);
    const key = randomUUID();
    const route = `/api/tech/jobs/${rid}/forms/${formId}/submit`;
    const scope = { organizationId: org, userId: lead, route, key };
    // The batch committed, but the key stayed claimed past the takeover window.
    expect(await fw.submitForm(actor(rid), { formId, appointmentId: v1, formVersion: 1, baseRevision: 0, changes: ALL_REQUIRED }, { submitKey: idem.derivedId(scope, "form-submit") })).toMatchObject({ ok: true });
    const body = { appointmentId: v1, formVersion: 1, baseRevision: 0, changes: ALL_REQUIRED };
    await run(sql`INSERT INTO idempotency_keys (organization_id,user_id,route,key,request_hash,state,attempt_id,created_at)
      VALUES (${org},${lead},${route},${key},${idem.canonicalHash(submitHashInput(body))},'in_progress',${randomUUID()},now() - interval '3 minutes')`);
    const taken = await submitVia(rid, v1, formId, key, ALL_REQUIRED);
    expect(taken.status).toBe(200);
    const sid = String((await row(rid, v1, formId))!.id);
    expect(await auditCount("form_submitted", sid)).toBe(1);

    const rev = Number((await row(rid, v1, formId))!.revision);
    expect(await fq.reopenSubmission(org, rid, sid, rev)).toMatchObject({ ok: true, changed: true });
    expect((await submitVia(rid, v1, formId, randomUUID(), ALL_REQUIRED, { base: rev + 1 })).status).toBe(200);
    expect(await auditCount("form_submitted", sid)).toBe(2);

    // A first-insert batch whose UPDATE misses writes no audit row. The writer refuses a non-zero base with
    // no row before batching (lead ruling 4), so drive the writer's own statements directly.
    const form2 = await newForm();
    const sub = { formId: form2, appointmentId: v1, formVersion: 1, baseRevision: 5, changes: ALL_REQUIRED };
    const k2 = randomUUID();
    const out = await runBatch([
      lockRequestSql(org, rid),
      fw.insertSubmissionSql(actor(rid), sub),
      fw.updateSubmissionSql(actor(rid), sub, null, sql`, status = 'submitted', submitted_by = ${lead}::uuid, submitted_at = now(), submit_key = ${k2}::uuid`),
      fw.submitAuditSql(actor(rid), sub, k2),
    ]);
    if (!Array.isArray(out)) throw new Error("batch");
    expect([out[1]!.length, out[2]!.length, out[3]!.length]).toEqual([1, 0, 0]);
    const created = await row(rid, v1, form2);
    expect(created).toMatchObject({ status: "draft", revision: 0 });
    expect(await auditCount("form_submitted", String(created!.id))).toBe(0);
    // Through the writer, the same request is STALE with nothing created.
    const form3 = await newForm();
    expect(envCode(await submitVia(rid, v1, form3, randomUUID(), ALL_REQUIRED, { base: 5 }))).toBe("STALE");
    expect(await row(rid, v1, form3)).toBeUndefined();
  }, 90_000);

  it("(d) two technicians from revision 0 at once → one lands, one STALE", async () => {
    const formId = await newForm();
    const rid = await newJob();
    const v1 = await visitOf(rid);
    await assign(v1, helper, { arrived: true });
    const [x, y] = await Promise.all([draft(rid, v1, formId, { [F.a]: true }), draft(rid, v1, formId, { [F.b]: true }, { me: helper })]);
    expect([code(x), code(y)].sort()).toEqual(["ok", "stale"]);
  }, 60_000);

  it("(e) a version-1 draft submits on version 1 after the office saves v2; FORM_CHANGED carry keeps a colleague's answers", async () => {
    const def = checklist();
    const formId = await newForm(def);
    const rid = await newJob();
    const v1 = await visitOf(rid);
    expect(await draft(rid, v1, formId, ALL_REQUIRED)).toMatchObject({ ok: true });
    const v2def: FormDef = { ...def, fields: [...def.fields, { id: "f_aaaaaaaaa7", type: "short_text", label: "Filter size", required: false }] };
    expect(await fq.updateForm(org, formId, { version: 1, definition: v2def })).toEqual({ ok: true, version: 2 });
    expect((await submitVia(rid, v1, formId, randomUUID(), {}, { base: 1, version: 1 })).status).toBe(200);
    expect((await row(rid, v1, formId))!.form_version).toBe(1);

    const v2 = await addVisit(rid, 2);
    await assign(v2, lead, { arrived: true, lead: true });
    await assign(v2, helper, { arrived: true });
    expect(await draft(rid, v2, formId, { "f_aaaaaaaaa7": "16x25x1" }, { me: helper, version: 2 })).toMatchObject({ ok: true, revision: 1 });
    expect(await draft(rid, v2, formId, { [F.c]: true }, { version: 1 })).toMatchObject({ ok: false, reason: "form_changed" });
    // The page carries base and mine to v2 and merges over the re-read row.
    const reread = await techView(rid, formId, v2);
    const carried = carryForNewVersion(reread.form.fields, {}, { [F.c]: true });
    const merged = mergeDraft(carried.base, carried.mine, reread.submission!.values!);
    expect(merged.values).toEqual({ "f_aaaaaaaaa7": "16x25x1", [F.c]: true });
    expect(await draft(rid, v2, formId, carried.mine, { version: 2, base: reread.submission!.revision })).toMatchObject({ ok: true, revision: 2 });
    expect((await techView(rid, formId, v2)).submission?.values).toEqual({ "f_aaaaaaaaa7": "16x25x1", [F.c]: true });
  }, 90_000);

  it("(f) gates: other visit, helper arrival arm, not on site, ended visit, other org, cancelled, completed", async () => {
    const formId = await newForm();
    const rid = await newJob({ status: "scheduled" });
    const v1 = await visitOf(rid);
    const v2 = await addVisit(rid, 2);
    await assign(v1, helper, { arrived: true });
    expect(await draft(rid, v2, formId, { [F.a]: true }, { me: helper })).toMatchObject({ ok: false, reason: "not_assigned" });
    expect(await draft(rid, v1, formId, { [F.a]: true }, { me: helper })).toMatchObject({ ok: true });
    expect(await draft(rid, v1, formId, { [F.b]: true }, { base: 1 })).toMatchObject({ ok: false, reason: "not_on_site" });
    // Unassigned from a visit that already has a row: the UPDATE's own visit gate refuses.
    await run(sql`UPDATE appointment_assignments SET status = 'cancelled'::request_status
      WHERE appointment_id = ${v1} AND technician_id = ${helper} AND organization_id = ${org}`);
    expect(await draft(rid, v1, formId, { [F.c]: true }, { me: helper, base: 1 })).toMatchObject({ ok: false, reason: "not_assigned" });
    expect((await row(rid, v1, formId))!.revision).toBe(1);

    const ended = await newJob();
    const ev = await visitOf(ended);
    await run(sql`UPDATE appointments SET cancelled_at = now() WHERE id = ${ev} AND organization_id = ${org}`);
    expect(await draft(ended, ev, formId, { [F.a]: true })).toMatchObject({ ok: false, reason: "visit_ended" });

    expect(await fr.getJobForms(org2, lead, rid, v1)).toEqual({ kind: "not_found" });
    expect(await fw.saveFormDraft({ organizationId: org2, requestId: rid, techUserId: lead }, {
      formId, appointmentId: v1, formVersion: 1, baseRevision: 0, saveId: randomUUID(), changes: { [F.a]: true },
    })).toMatchObject({ ok: false, reason: "not_found" });

    // A form of ANOTHER org, by its id, is never visible or writable here (tenancy, spec §9).
    const org2Owner = String((await run(sql`SELECT id FROM users WHERE organization_id = ${org2} LIMIT 1`))[0]!.id);
    const foreign = await fq.createForm(org2, org2Owner, randomUUID(), checklist(undefined, { required: true }));
    if (!foreign.ok) throw new Error(foreign.reason);
    const mine = await newJob();
    const mv = await visitOf(mine);
    expect(await fr.getJobForm(org, lead, mine, foreign.id, mv)).toEqual({ kind: "not_found" });
    expect(await draft(mine, mv, foreign.id, { [F.a]: true })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await fq.getForm(org, foreign.id)).toBeNull();
    expect(await fq.updateForm(org, foreign.id, { version: 1, active: false })).toEqual({ ok: false, reason: "not_found" });
    const card = await fr.getJobForms(org, lead, mine, mv);
    if (card.kind !== "ok") throw new Error(card.kind);
    expect([...card.view.forms, ...card.view.otherForms].map((f) => f.formId)).not.toContain(foreign.id);
    expect((await fq.getRequestForms(org, mine))?.missingRequired.map((m) => m.formId)).not.toContain(foreign.id);

    const gone = await newJob();
    const gv = await visitOf(gone);
    await run(sql`UPDATE service_requests SET status = 'cancelled'::request_status WHERE id = ${gone} AND organization_id = ${org}`);
    expect(await draft(gone, gv, formId, { [F.a]: true })).toMatchObject({ ok: false, reason: "job_closed" });

    const doneJob = await newJob({ status: "completed" });
    expect(await draft(doneJob, await visitOf(doneJob), formId, { [F.a]: true })).toMatchObject({ ok: true });
  }, 90_000);

  it("(g) synced job: write and submit; cancelled → JOB_CLOSED; the trigger keeps a visit with a submission; cascades", async () => {
    const formId = await newForm();
    const rid = await newJob({ fieldpulse: true, status: "scheduled" });
    const v1 = await visitOf(rid);
    expect(await draft(rid, v1, formId, ALL_REQUIRED)).toMatchObject({ ok: true });
    expect((await submitVia(rid, v1, formId, randomUUID(), {}, { base: 1 })).status).toBe(200);

    // A sync-style UPDATE clearing assignment, date and window: the visit stays (times NULL, lead demoted).
    await run(sql`UPDATE service_requests SET assigned_to = NULL, scheduled_date = NULL, arrival_window_start = NULL, arrival_window_end = NULL
      WHERE id = ${rid} AND organization_id = ${org}`);
    const kept = await run(sql`SELECT p.id, p.scheduled_date, a.is_lead FROM appointments p LEFT JOIN appointment_assignments a ON a.appointment_id = p.id
      WHERE p.service_request_id = ${rid} AND p.organization_id = ${org}`);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: v1, scheduled_date: null, is_lead: false });
    const office = await fq.getRequestForms(org, rid);
    expect(office?.submissions.map((s) => s.status)).toEqual(["submitted"]);

    const synced2 = await newJob({ fieldpulse: true, status: "scheduled" });
    await run(sql`UPDATE service_requests SET status = 'cancelled'::request_status WHERE id = ${synced2} AND organization_id = ${org}`);
    expect(await draft(synced2, await visitOf(synced2), formId, { [F.a]: true })).toMatchObject({ ok: false, reason: "job_closed" });

    // Native completed job with no progress: same keep.
    const nat = await newJob({ status: "completed" });
    const nv = await visitOf(nat);
    expect(await draft(nat, nv, formId, { [F.a]: true })).toMatchObject({ ok: true });
    await run(sql`UPDATE service_requests SET assigned_to = NULL, scheduled_date = NULL WHERE id = ${nat} AND organization_id = ${org}`);
    expect(await run(sql`SELECT id FROM appointments WHERE id = ${nv} AND organization_id = ${org}`)).toHaveLength(1);

    // A visit with no submission under the same UPDATE is deleted, as in 0050.
    const bare = await newJob({ status: "scheduled" });
    await run(sql`UPDATE service_requests SET assigned_to = NULL, scheduled_date = NULL WHERE id = ${bare} AND organization_id = ${org}`);
    expect(await run(sql`SELECT id FROM appointments WHERE service_request_id = ${bare} AND organization_id = ${org}`)).toHaveLength(0);

    // A direct visit delete that would orphan answers fails with the foreign key error.
    await expect(db.execute(sql`DELETE FROM appointments WHERE id = ${nv} AND organization_id = ${org}`)).rejects.toThrow();
    try {
      await db.execute(sql`DELETE FROM appointments WHERE id = ${nv} AND organization_id = ${org}`);
    } catch (error) {
      const { errorCode } = await import("@/lib/logger");
      expect(errorCode(error)).toBe("23503");
    }

    // Deleting the request (the session delete path) cascades visit and submission in one statement.
    await run(sql`DELETE FROM service_requests WHERE id = ${nat} AND organization_id = ${org}`);
    expect(await run(sql`SELECT id FROM form_submissions WHERE service_request_id = ${nat}`)).toHaveLength(0);
    expect(await run(sql`SELECT id FROM appointments WHERE id = ${nv}`)).toHaveLength(0);
  }, 120_000);

  it("(g2) purging an org with a submission succeeds and cascades it", async () => {
    const { createOrgCore } = await import("@/lib/admin/provisioning");
    const out = await createOrgCore({
      name: `Probe Org Field Forms Purge ${randomUUID().slice(0, 8)}`, createdBy: null, ownerEmail: null,
      ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
      skipOrgCountCheck: true,
    });
    if (!out.ok) throw new Error("createOrgCore failed");
    const p = out.result.organizationId;
    try {
      const t = (await run(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
        VALUES (${p},'tech-'||gen_random_uuid()||'@throwaway.example','Purge Tech','technician','x',true) RETURNING id`))[0]!.id as string;
      const f = await fq.createForm(p, out.result.ownerUserId!, randomUUID(), checklist());
      if (!f.ok) throw new Error(f.reason);
      const sess = (await run(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${p},gen_random_uuid()::text) RETURNING id`))[0]!.id as string;
      const r = (await run(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,issue_type,urgency,description,reference_number,scheduled_date,status)
        VALUES (${p},${sess},${t},'no_heat','medium','Purge probe','PRG-'||substr(md5(random()::text),1,8),now(),'arrived'::request_status) RETURNING id`))[0]!.id as string;
      const a = (await run(sql`SELECT id FROM appointments WHERE service_request_id = ${r}`))[0]!.id as string;
      expect(await fw.saveFormDraft({ organizationId: p, requestId: r, techUserId: t }, {
        formId: f.id, appointmentId: a, formVersion: 1, baseRevision: 0, saveId: randomUUID(), changes: { [F.a]: true },
      })).toMatchObject({ ok: true });
      await run(sql`DELETE FROM organizations WHERE id = ${p}`);
      expect(await run(sql`SELECT id FROM form_submissions WHERE organization_id = ${p}`)).toHaveLength(0);
      expect(await run(sql`SELECT id FROM forms WHERE organization_id = ${p}`)).toHaveLength(0);
    } finally {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${p}`).catch(() => undefined);
    }
  }, 90_000);

  it("(h) archived: an existing draft saves and submits; can't start on a new visit; non-applicable active forms start; Clear answers", async () => {
    const formId = await newForm();
    const rid = await newJob();
    const v1 = await visitOf(rid);
    expect(await draft(rid, v1, formId, { [F.a]: true })).toMatchObject({ ok: true });
    expect(await fq.updateForm(org, formId, { version: 1, active: false })).toMatchObject({ ok: true });
    expect(await draft(rid, v1, formId, { [F.b]: true }, { base: 1 })).toMatchObject({ ok: true, revision: 2 });
    expect((await submitVia(rid, v1, formId, randomUUID(), {}, { base: 2 })).status).toBe(200);
    const v2 = await addVisit(rid, 2);
    await assign(v2, lead, { arrived: true, lead: true });
    expect(await draft(rid, v2, formId, { [F.a]: true })).toMatchObject({ ok: false, reason: "form_archived" });
    expect(await fr.getJobForm(org, lead, rid, formId, v2)).toEqual({ kind: "archived" });

    const other = await newForm(checklist(undefined, { jobTypeIds: [jobType] }));
    const typed = await newJob(); // job_type_id NULL: the form doesn't apply
    const tv = await visitOf(typed);
    const card = await fr.getJobForms(org, lead, typed, tv);
    if (card.kind !== "ok") throw new Error(card.kind);
    expect(card.view.otherForms.map((o) => o.formId)).toContain(other);
    expect(await draft(typed, tv, other, { [F.a]: true })).toMatchObject({ ok: true });
    // Clear answers: every answered field as null → NULL blob, Not started, hidden from the office.
    expect(await draft(typed, tv, other, { [F.a]: null }, { base: 1 })).toMatchObject({ ok: true, revision: 2 });
    expect((await row(typed, tv, other))!.values_encrypted).toBeNull();
    const after = await fr.getJobForms(org, lead, typed, tv);
    if (after.kind !== "ok") throw new Error(after.kind);
    expect(after.view.forms.find((f) => f.formId === other)?.submission?.hasAnswers).toBe(false);
    expect((await fq.getRequestForms(org, typed))?.submissions).toEqual([]);
  }, 90_000);

  it("(i) erase: answers and request + equipment attachments go; later writes refused; races leave nothing; delete keeps answers", async () => {
    const cust = await newCustomer();
    const formId = await newForm();
    const rid = await newJob({ customerId: cust });
    const v1 = await visitOf(rid);
    expect(await draft(rid, v1, formId, { [F.note]: SECRET })).toMatchObject({ ok: true });
    const unit = (await run(sql`INSERT INTO customer_equipment (organization_id,customer_id,equipment_type) VALUES (${org},${cust},'ac'::equipment_type) RETURNING id`))[0]!.id as string;
    await run(sql`INSERT INTO attachments (organization_id,service_request_id,filename,mime_type,size,storage_key) VALUES (${org},${rid},'a.jpg','image/jpeg',1,'probe/request.jpg')`);
    await run(sql`INSERT INTO attachments (organization_id,equipment_id,filename,mime_type,size,storage_key) VALUES (${org},${unit},'b.pdf','application/pdf',1,'probe/unit.pdf')`);
    afterCallbacks.length = 0;
    deletedKeys.length = 0;

    expect(await anonymizeCustomer(org, cust)).toBe(true);
    const r = await row(rid, v1, formId);
    expect(r).toMatchObject({ values_encrypted: null, status: "draft" });
    expect(r!.erased_at).not.toBeNull();
    expect(await run(sql`SELECT id FROM attachments WHERE organization_id = ${org} AND (service_request_id = ${rid} OR equipment_id = ${unit})`)).toHaveLength(0);
    for (const cb of afterCallbacks) await cb();
    expect(deletedKeys).toEqual(expect.arrayContaining(["probe/request.jpg", "probe/unit.pdf"]));
    const audit = (await run(sql`SELECT details FROM audit_log WHERE organization_id = ${org} AND action = 'customer_erased' AND entity_id = ${cust}`))[0]!;
    expect(JSON.parse(String(audit.details)).attachmentsDeleted).toBe(2);

    expect(await draft(rid, v1, formId, { [F.a]: true }, { base: 1 })).toMatchObject({ ok: false, reason: "answers_removed" });
    expect(await draft(rid, v1, await newForm(), { [F.a]: true })).toMatchObject({ ok: false, reason: "customer_removed" });
    expect(await addJobPhoto(org, lead, rid, { filename: "c.jpg", mimeType: "image/jpeg", size: 1, storageKey: "probe/c.jpg" })).toEqual({ ok: false, reason: "customer_removed" });

    // Races on two connections: an erase against a first save, and against a photo insert.
    for (let i = 0; i < 3; i++) {
      const c2 = await newCustomer();
      const r2 = await newJob({ customerId: c2 });
      const a2 = await visitOf(r2);
      const f2 = await newForm();
      await Promise.all([
        draft(r2, a2, f2, { [F.note]: SECRET }),
        addJobPhoto(org, lead, r2, { filename: "d.jpg", mimeType: "image/jpeg", size: 1, storageKey: `probe/race-${i}.jpg` }),
        anonymizeCustomer(org, c2),
      ]);
      const leftover = await run(sql`SELECT id FROM form_submissions WHERE organization_id = ${org} AND service_request_id = ${r2} AND values_encrypted IS NOT NULL`);
      expect(leftover).toHaveLength(0);
      expect(await run(sql`SELECT id FROM attachments WHERE organization_id = ${org} AND service_request_id = ${r2}`)).toHaveLength(0);
    }

    // deleteCustomer detaches; the request's submission stays.
    const c3 = await newCustomer();
    const r3 = await newJob({ customerId: c3 });
    const a3 = await visitOf(r3);
    expect(await draft(r3, a3, formId, { [F.a]: true })).toMatchObject({ ok: true });
    expect(await deleteCustomer(org, c3)).toBe(true);
    expect((await row(r3, a3, formId))!.values_encrypted).not.toBeNull();
  }, 120_000);

  it("(j) reopen: changed; stale; already a draft; resubmit", async () => {
    const formId = await newForm();
    const rid = await newJob();
    const v1 = await visitOf(rid);
    expect((await submitVia(rid, v1, formId, randomUUID(), ALL_REQUIRED)).status).toBe(200);
    const r = (await row(rid, v1, formId))!;
    const rev = Number(r.revision);
    expect(await fq.reopenSubmission(org, rid, String(r.id), rev - 1)).toEqual({ ok: false, reason: "stale" });
    // Another request's id never reaches this submission.
    expect(await fq.reopenSubmission(org, await newJob(), String(r.id), rev)).toEqual({ ok: false, reason: "not_found" });
    expect(await fq.reopenSubmission(org, rid, String(r.id), rev)).toMatchObject({ ok: true, changed: true, revision: rev + 1 });
    expect(await fq.reopenSubmission(org, rid, String(r.id), rev)).toMatchObject({ ok: true, changed: false });
    expect((await submitVia(rid, v1, formId, randomUUID(), {}, { base: rev + 1 })).status).toBe(200);
  }, 60_000);

  it("(k) an undecryptable blob: tech GET unreadable, save refused, office unreadable, never a 500", async () => {
    const formId = await newForm();
    const rid = await newJob();
    const v1 = await visitOf(rid);
    expect(await draft(rid, v1, formId, { [F.a]: true })).toMatchObject({ ok: true });
    await run(sql`UPDATE form_submissions SET values_encrypted = 'not-a-ciphertext' WHERE organization_id = ${org} AND service_request_id = ${rid}`);
    const v = await techView(rid, formId, v1);
    expect([v.writeBlockedReason, v.submission?.values]).toEqual(["unreadable", null]);
    expect(await draft(rid, v1, formId, { [F.b]: true }, { base: 1 })).toMatchObject({ ok: false, reason: "answers_unreadable" });
    const office = await fq.getRequestForms(org, rid);
    expect(office?.submissions[0]).toMatchObject({ unreadable: true, values: null });
  }, 60_000);

  it("(l) site: location and address scope, synced none, future and other-customer exclusions, membership states, tenancy", async () => {
    const A = "12 Elm St, Johnson City, TN 37601";
    const cust = await newCustomer();
    const loc = (await run(sql`INSERT INTO customer_locations (organization_id,customer_id,address_encrypted,label,is_primary) VALUES (${org},${cust},${encrypt(A)},'Main house',true) RETURNING id`))[0]!.id as string;
    const pastSame = await newJob({ customerId: cust, locationId: loc, address: A, status: "completed" });
    const pastAddr = await newJob({ customerId: cust, address: "12 elm st,  johnson city, tn 37601", status: "completed" });
    const future = await newJob({ customerId: cust, locationId: loc, address: A, status: "scheduled" });
    await run(sql`UPDATE service_requests SET scheduled_date = now() + interval '10 days' WHERE id = ${future} AND organization_id = ${org}`);
    const cancelledElsewhere = await newJob({ customerId: cust, address: "99 Far Rd, Bristol, TN", status: "cancelled" });
    const custB = await newCustomer();
    const otherCust = await newJob({ customerId: custB, address: A, status: "completed" });
    const plan = (await run(sql`INSERT INTO membership_plans (organization_id,name,price_cents,visits_per_year) VALUES (${org},'Comfort Club',1500,2) RETURNING id`))[0]!.id as string;
    const mem = (await run(sql`INSERT INTO customer_memberships (organization_id,customer_id,plan_id,status) VALUES (${org},${cust},${plan},'active') RETURNING id`))[0]!.id as string;
    await run(sql`INSERT INTO membership_visits (organization_id,customer_membership_id,due_date,period_key,status) VALUES
      (${org},${mem},now() + interval '30 days','2027-H1','scheduled'),(${org},${mem},now() - interval '30 days','2026-H2','scheduled')`);
    const openEstimate = async (rid: string, c: string) =>
      (await run(sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents) VALUES (${org},${rid},${c},'open',481200) RETURNING id`))[0]!.id as string;
    const est = await openEstimate(pastSame, cust);
    // Estimates on unmatched requests never list: another customer's, and a cancelled request's.
    const estOther = await openEstimate(otherCust, custB);
    const estCancelled = await openEstimate(cancelledElsewhere, cust);
    // The customer's other location (another address): never on this site.
    const loc2 = (await run(sql`INSERT INTO customer_locations (organization_id,customer_id,address_encrypted,label) VALUES (${org},${cust},${encrypt("40 Oak Ave, Bristol, TN")},'Rental') RETURNING id`))[0]!.id as string;
    const atLoc2 = await newJob({ customerId: cust, locationId: loc2, address: "40 Oak Ave, Bristol, TN", status: "completed" });

    const job = await newJob({ customerId: cust, locationId: loc, address: A });
    const site = await sq.getSiteView(org, lead, job);
    if (site.kind !== "ok") throw new Error(site.kind);
    expect(site.view.scope).toBe("location");
    expect(site.view.pastJobs.map((j) => j.id).sort()).toEqual([pastSame, pastAddr].sort());
    expect(site.view.pastJobs.map((j) => j.id)).not.toContain(future);
    expect(site.view.pastJobs.map((j) => j.id)).not.toContain(otherCust);
    expect(site.view.pastJobs.map((j) => j.id)).not.toContain(atLoc2);
    expect(site.view.openEstimates.map((e) => e.id)).toEqual([est]);
    expect(site.view.openEstimates.map((e) => e.id)).not.toContain(estOther);
    expect(site.view.openEstimates.map((e) => e.id)).not.toContain(estCancelled);
    // Two locations: membership is withheld (whether or not there is one).
    expect(site.view.membership).toEqual({ state: "withheld" });

    const byAddr = await newJob({ customerId: cust, address: A });
    const s2 = await sq.getSiteView(org, lead, byAddr);
    if (s2.kind !== "ok") throw new Error(s2.kind);
    expect(s2.view.scope).toBe("address");

    // Member: a single-location customer whose every request has the same address.
    const custM = await newCustomer();
    const locM = (await run(sql`INSERT INTO customer_locations (organization_id,customer_id,address_encrypted,is_primary) VALUES (${org},${custM},${encrypt(A)},true) RETURNING id`))[0]!.id as string;
    const memM = (await run(sql`INSERT INTO customer_memberships (organization_id,customer_id,plan_id,status) VALUES (${org},${custM},${plan},'active') RETURNING id`))[0]!.id as string;
    await run(sql`INSERT INTO membership_visits (organization_id,customer_membership_id,due_date,period_key,status) VALUES
      (${org},${memM},now() + interval '30 days','2027-H1','scheduled'),(${org},${memM},now() - interval '30 days','2026-H2','scheduled')`);
    const mJob = await newJob({ customerId: custM, locationId: locM, address: A });
    const sm = await sq.getSiteView(org, lead, mJob);
    if (sm.kind !== "ok") throw new Error(sm.kind);
    expect(sm.view.membership).toMatchObject({ state: "member", planName: "Comfort Club" });
    if (sm.view.membership.state === "member") expect(sm.view.membership.upcoming).toHaveLength(1); // the overdue visit is excluded

    // A two-location customer with NO membership is withheld too (existence isn't leaked).
    const custN = await newCustomer();
    const locN = (await run(sql`INSERT INTO customer_locations (organization_id,customer_id,address_encrypted) VALUES (${org},${custN},${encrypt(A)}) RETURNING id`))[0]!.id as string;
    await run(sql`INSERT INTO customer_locations (organization_id,customer_id,address_encrypted) VALUES (${org},${custN},${encrypt("9 Pine Ct, Kingsport, TN")})`);
    const nJob = await newJob({ customerId: custN, locationId: locN, address: A });
    const s3 = await sq.getSiteView(org, lead, nJob);
    if (s3.kind !== "ok") throw new Error(s3.kind);
    expect(s3.view.membership).toEqual({ state: "withheld" });

    const custC = await newCustomer();
    const cJob = await newJob({ customerId: custC, address: A });
    const synced = await newJob({ customerId: custC, fieldpulse: true, status: "scheduled" });
    const s4 = await sq.getSiteView(org, lead, cJob);
    if (s4.kind !== "ok") throw new Error(s4.kind);
    expect(s4.view.membership).toEqual({ state: "withheld" });
    const syncedEst = await openEstimate(synced, custC);
    const s5 = await sq.getSiteView(org, lead, synced);
    if (s5.kind !== "ok") throw new Error(s5.kind);
    expect([s5.view.scope, s5.view.unaddressedCount, s5.view.pastJobs]).toEqual(["none", 0, []]);
    expect(s5.view.openEstimates.map((e) => e.id)).toEqual([syncedEst]); // under `none` this job's own still list
    const s6 = await sq.getSiteView(org, lead, cJob);
    if (s6.kind !== "ok") throw new Error(s6.kind);
    expect(s6.view.unaddressedCount).toBe(1);

    expect(await sq.getSiteView(org2, lead, job)).toEqual({ kind: "not_found" });
  }, 120_000);

  it("(m) missingRequired: completed yes, cancelled no; hold-ended visit counts; untouched cancelled visit doesn't; created after completion not listed", async () => {
    const formId = await newForm();
    const rid = await newJob({ status: "completed" });
    await run(sql`UPDATE service_requests SET completed_at = now() WHERE id = ${rid} AND organization_id = ${org}`);
    expect((await fq.getRequestForms(org, rid))?.missingRequired.map((m) => m.formId)).toContain(formId);
    const late = await newForm();
    expect((await fq.getRequestForms(org, rid))?.missingRequired.map((m) => m.formId)).not.toContain(late);

    const cancelled = await newJob();
    await run(sql`UPDATE service_requests SET status = 'cancelled'::request_status WHERE id = ${cancelled} AND organization_id = ${org}`);
    expect((await fq.getRequestForms(org, cancelled))?.missingRequired).toEqual([]);

    const held = await newJob();
    const hv = await visitOf(held);
    expect((await submitVia(held, hv, formId, randomUUID(), ALL_REQUIRED)).status).toBe(200);
    await run(sql`UPDATE appointments SET cancelled_at = now() WHERE id = ${hv} AND organization_id = ${org}`);
    const heldForms = await fq.getRequestForms(org, held);
    expect(heldForms?.missingRequired.map((m) => m.formId)).not.toContain(formId);
    expect(heldForms?.submissions[0]?.visitState).toBe("ended");

    // Lead ruling 13: (m)'s "a visit cancelled before any work doesn't count" can only mean a visit with NO
    // submission — §5.1 makes any visit holding a submission count. Pin both sides.
    const preWork = await newJob();
    const pv = await visitOf(preWork);
    expect((await submitVia(preWork, pv, formId, randomUUID(), ALL_REQUIRED)).status).toBe(200);
    await run(sql`UPDATE appointment_assignments SET status = 'cancelled'::request_status WHERE appointment_id = ${pv} AND organization_id = ${org}`);
    await run(sql`UPDATE appointments SET cancelled_at = now() WHERE id = ${pv} AND organization_id = ${org}`);
    expect((await fq.getRequestForms(org, preWork))?.missingRequired.map((m) => m.formId)).not.toContain(formId);
    const fresh = await newJob();
    const fv2 = await addVisit(fresh, 2);
    await run(sql`UPDATE appointments SET cancelled_at = now() WHERE id = ${fv2} AND organization_id = ${org}`);
    expect(await fr.getJobForms(org, lead, fresh, fv2)).toEqual({ kind: "not_found" });
  }, 90_000);

  it("(n) form audit rows carry ids and enums only; stored keys hold no answer", async () => {
    const formId = await newForm();
    const rid = await newJob();
    expect((await submitVia(rid, await visitOf(rid), formId, randomUUID(), { ...ALL_REQUIRED, [F.note]: SECRET })).status).toBe(200);
    const rows = await run(sql`SELECT action, details FROM audit_log WHERE organization_id = ${org} AND action LIKE 'form_%'`);
    expect(rows.length).toBeGreaterThan(0);
    const allowed = new Set(["formId", "appointmentId", "formVersion", "version", "fieldCount"]);
    for (const r of rows) {
      expect(String(r.details)).not.toContain(SECRET);
      expect(Object.keys(JSON.parse(String(r.details))).every((k) => allowed.has(k))).toBe(true);
    }
    const stored = await run(sql`SELECT request_hash, response_body FROM idempotency_keys WHERE organization_id = ${org}`);
    for (const s of stored) expect(JSON.stringify(s)).not.toContain(SECRET);
  }, 60_000);

  it("migration 0058 applies twice, statement by statement", async () => {
    const statements = readFileSync("drizzle/0058_m3d_forms.sql", "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBe(23);
    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of statements) await db.execute(sql.raw(stmt));
    }
  }, 60_000);
});
```

- [ ] **Step 2: Register it** (re-read `vitest.config.ts` first; another workstream appends to the same array):

```diff
diff --git a/vitest.config.ts b/vitest.config.ts
index 0342e54..532d52d 100644
--- a/vitest.config.ts
+++ b/vitest.config.ts
@@ -27,6 +27,8 @@ const INTEGRATION_SUITES = [
   "tests/integration/hold-next-visit.test.ts",
   // M3c sell on site: estimates, bill once, equipment against the dev DB (two throwaway orgs).
   "tests/integration/field-estimate.test.ts",
+  // M3d forms + site view: writers, trigger, erase and site reads against the dev DB (throwaway orgs).
+  "tests/integration/field-forms.test.ts",
 ];
 
 // `npm run test:integration` sets this to invert the selection: run ONLY the
```

- [ ] **Step 3: Run it**

Run: `VITEST_INTEGRATION=1 npx vitest run tests/integration/field-forms.test.ts`
Expected: PASS (16 tests). Then `VITEST_INTEGRATION=1 npx vitest run tests/integration/field-estimate.test.ts tests/integration/field-invoice.test.ts tests/integration/hold-next-visit.test.ts` still PASS (the trigger change and the erase widening must not move them), and `npx vitest run` still excludes all four. Confirm the probe orgs are gone: `SELECT count(*) FROM organizations WHERE name LIKE 'Probe Org Field Forms%'` → 0.

- [ ] **Step 4: Commit the suite**

```bash
npx tsc --noEmit && npx eslint tests/integration/field-forms.test.ts vitest.config.ts && npx vitest run
git add tests/integration/field-forms.test.ts vitest.config.ts
git commit -m "$(cat <<'EOF'
test(m3d): field forms integration suite (a)-(n) incl. trigger keep, cascades, erase races, site scope

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

- [ ] **Step 5: Docs (spec §13).**
  - `.claude/skills/page-tech/SKILL.md` — add a section after "Sell on site (M3c …)":

```markdown
**Forms + site view (M3d, `/tech/jobs/[id]/forms/[formId]`, `/tech/jobs/[id]/site`):**
- **Files:** pages `src/app/tech/jobs/[id]/forms/[formId]/page.tsx`, `src/app/tech/jobs/[id]/site/page.tsx` ·
  components `src/components/tech/forms/` (`forms-card.tsx`, `form-fill-client.tsx`,
  `form-field-input.tsx`), `src/components/tech/site/` (`site-card.tsx`, `site-page-client.tsx`,
  `fetch-site.ts`), `job-photos-card.tsx` · writers `src/lib/tech/form-writes.ts`
  (`saveFormDraft`, `submitForm`), `src/lib/tech/photo-writes.ts` (`addJobPhoto`) · reads
  `src/lib/tech/form-reads.ts`, `src/lib/tech/site-queries.ts` · pure `src/lib/forms/`
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
  submit route's idempotency key (`formGateFail` runs inside the keyed run). A pre-read revision
  other than `baseRevision` is STALE before any decrypt.
- **Visits counts** = live, or progressed/completed work on it, or a submission. Migration 0058
  re-creates `sync_request_appointment()` with ONE added predicate: a visit with any
  `form_submissions` row (an empty draft included) is kept (times nulled, lead demoted) instead
  of deleted. `form_submissions.appointment_id` is NO ACTION.
- **Client:** autosave timing is `form-save-machine.ts` (1.5 s debounce, one in flight, 3 s
  floor, unknown re-sent first with its saveId, 3 → 30 s back-off, hidden/pagehide flush);
  answer bookkeeping is `form-fill-state.ts` (touched fields, last valid number, landed body
  advances base). The submit intent lives in `tech:estimate:<rid>:intents` as
  `form:submit:<formId>:<aid>`; the fill page recovers it itself.
- **Close-out:** required forms not submitted on any visit that counts show as non-blocking
  "Fill in “…”" links in `close-out-sheet.tsx`; nothing blocks (row 126 deferred).
- **Site:** match by `location_id`, else by `normalizeAddress` of the request's own address;
  never the customer's other address, never a fallback. Membership `member | none | withheld`.
  `isLead` comes from `isActiveLead` (`ownership.ts`, shared with the M3c estimates GET); this
  job's open native estimates are links for the lead only.
- **Photos:** quality per device (`tech:photo-quality`), resized on the phone, PDFs via
  `Add file`, 4 MB on phone and route; an erased customer's job refuses uploads
  (409 CUSTOMER_REMOVED, object deleted).
- **Verify:** `npx vitest run src/lib/forms src/lib/tech/form-*.test.ts src/lib/tech/site-*.test.ts src/lib/tech/photo-*.test.ts "src/app/api/tech/jobs/[id]/forms" "src/app/api/tech/jobs/[id]/site" "src/app/api/tech/jobs/[id]/photo"`;
  dev DB: `VITEST_INTEGRATION=1 npx vitest run tests/integration/field-forms.test.ts`.
```

  - `.claude/skills/page-settings/SKILL.md` — after the Job types + Tags section: "**Forms tab (M3d, `?tab=forms`):** `src/components/admin/settings/forms-panel.tsx`; builder `/admin/settings/forms/new` and `/admin/settings/forms/[id]` (`src/app/admin/(dashboard)/settings/forms/[id]/page.tsx`, `src/components/admin/forms/form-builder-client.tsx`, `form-field-editor.tsx`, pure `src/lib/admin/form-builder.ts`). `New form` inserts nothing; the first valid Save POSTs a client token (`officeId("form", org, token)`; 201 → URL replaced natively, 200 replay → GET and stay dirty if different, unknown → re-POST the same token). Edits PATCH `{ version, definition }`, archive/restore `{ version, active }`; 409 STALE / NAME_TAKEN, 400 UNKNOWN_JOB_TYPE, 409 LIMIT_REACHED (100). Forms are archived, never deleted. Save is disabled with 'Fix these to save:' (one message per rule, `builderErrors`). Routes `src/app/api/admin/settings/forms/{route,[id]/route}.ts`, queries `src/lib/admin/form-queries.ts`."
  - `.claude/skills/page-requests/SKILL.md` — "**Forms section (M3d):** `src/components/admin/request-forms-section.tsx` after Visits on the detail sheet; `GET /api/admin/requests/[id]/forms` (`getRequestForms`: submissions with answers decrypted server-side — undecryptable → `unreadable`, never a 500 — answerless drafts omitted, `missingRequired` per request status) and `POST …/forms/[submissionId]/reopen` `{ revision }` (CAS; audit `form_reopened`; nobody is notified)."
  - `.claude/skills/page-customers/SKILL.md` — under the erase notes: "**Erase (M3d):** the batch locks the customer's requests first, counts and deletes attachments in SQL (`DELETE … RETURNING storage_key`, `src/lib/admin/erasure-sql.ts`) — the customer's own, chat uploads in their sessions, files on their requests (technician photos and PDFs, office request documents) and files on their equipment — and nulls form answers (`erased_at` set; status and who/when kept). Technician uploads and new answers on an erased customer's requests are refused (CUSTOMER_REMOVED). `deleteCustomer` still detaches and keeps answers with the request."
  - Run `node scripts/agent/verify-skills.mjs` → 0 missing.
  - `replica/features.csv`: line 122 `Photos / video / files on job with quality setting,tech-app,must,yes,partial,photos with a quality setting + PDF files; no video`; line 125 `Job forms and checklists,tech-app,must,yes,yes,native and synced jobs; on synced jobs the technician FieldPulse lists first fills them`; line 126 `Required forms block close-out,tech-app,should,yes,no,forms can be marked Required; the Forms card, the close-out sheet and the office remind; nothing blocks (deferred: it would change the M3a close-out batch)`; line 131 `Location info tab (history / opportunities / recurring),tech-app,must,yes,partial,past jobs, open estimates and membership at the same location or saved address; FieldPulse-synced jobs carry no address, so their history is counted, not shown; flips to yes when FieldPulse job addresses are imported (follow-up)`. (Wrap a note in double quotes if it contains a comma, as the file already does.)
  - `replica/parity.md`: regenerate with the `replica-diff` skill (it rewrites the file from `features.csv`); report the old → new score.
  - `replica/build-log.md` — append:

```text
M3d | 2026-11-07 | done | required forms blocking close-out (row 126); photo/signature/file form fields, conditional logic, templates, PDF of a submission; offline mode (row 124); video; synced-job site history (no FieldPulse job addresses on file) | Forms + site view: migration 0058 (forms, form_submissions with NO ACTION visit/form keys, sync_request_appointment() keeps a visit with any submission); Settings Forms tab + builder (client-token first save, version CAS, archive); tech Forms card after the summary, fill page with server autosave (changes + revision gate + saveId replay first), three-way merge and FORM_CHANGED carry, keyed submit with xmin-gated in-batch audit and labelled-HMAC request hash; office Forms section with reopen; close-out reminder links (non-blocking); Site page (location or saved-address match, membership member/none/withheld); photos quality + phone resize + PDF files, 4 MB cap; erase locks requests first and removes request + equipment attachments and answers; rulings: gate order (JOB_CLOSED first, VISIT_ENDED only to a technician on the visit), techFormFront/techFormGate split, NOT_ASSIGNED 403, addJobPhoto moved to photo-writes.ts, PATCH {version, definition|active}, myRowCancelled on the GETs, replaceState for the builder's first save; integration suite tests/integration/field-forms.test.ts (a)-(n) + cascades
```

  - `replica/architecture.md` — in the "M3d Forms + site view" paragraph append: "Shipped 2026-11-07 (plan `docs/superpowers/plans/2026-11-07-replica-m3d-forms-site-view.md`). As built: forms on native AND synced jobs (on synced jobs the technician FieldPulse lists first); 0058 changes the 0049/0050 visit trigger by one predicate (a visit with a submission is kept); video cut; row 126 deferred (Required reminds, never blocks); only the office reopens a submitted form." And in the API table row for M3d (~line 244) replace the route list with "`GET /api/tech/jobs/[id]/forms?visit=`, `GET …/forms/[formId]?visit=`, `PUT …/draft`, `POST …/submit`; office `/api/admin/settings/forms`, `/api/admin/requests/[id]/forms`" and the write note with "draft PUT applies `changes` under a revision gate on `(appointment_id, form_id, service_request_id)`".
  - Memory: update `/Users/sizbei/.claude/projects/-Users-sizbei-Documents-GitHub-ai-hvac-agent/memory/replica-program-fp-st.md` with "M3d Forms + site view built (commits listed, pushed or not, NOT deployed by this plan; migration 0058 applies in the build), parity <old> → <new>; deploy check: measure a 5 MB upload on a preview (Vercel 4.5 MB) and photo resize on a real iPhone" and the rulings list above; update its `MEMORY.md` index line. (Outside the repo: not committed.)

- [ ] **Step 6: Gates and commit the docs**

```bash
node scripts/agent/verify-skills.mjs && npx vitest run
git add .claude/skills/page-tech/SKILL.md .claude/skills/page-settings/SKILL.md .claude/skills/page-requests/SKILL.md .claude/skills/page-customers/SKILL.md replica/features.csv replica/parity.md replica/build-log.md replica/architecture.md
git commit -m "$(cat <<'EOF'
docs(m3d): skills, feature matrix, parity, build log, architecture annotation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

## Self-review

**1. Spec coverage**

| spec | where |
| --- | --- |
| §1 done-when (admin builds; tech fills half, reloads, sees the draft, submits; office sees it; erase anonymises; location tab lists jobs, estimates, membership) | Tasks 9, 10b, 11 (UI + walks), Task 12 (b), (i), (l) |
| §1 features 122 / 125 / 126 / 131 | Task 12 docs |
| §2 surfaces (Forms tab + builder, request Forms section, Forms card after the summary, fill page, close-out reminder, Site card + page, Photos) | Tasks 9, 11, 10b, 10b, 10b, 11, 11 |
| §3 / §3.1–3.2 migration 0058 (tables, NO ACTION keys, checks, indexes, journal `when`, scratch snapshot, No schema changes, dev migrate + catalog check) | Task 1 (+ Task 12 re-apply) |
| §3.3 field model, limits, ids, controls, 128 KB UTF-8 measure, `draftValueOk`, `numberInputState`, `missingRequired`, `answerText`, error details | Task 2 (+ Task 4 writer use) |
| §3.4 trigger: 0050 verbatim + one predicate, render diff test | Task 1 test; behaviour Task 12 (g) |
| §4.1 office ids, 201 / 200 replay / unknown, `firstSaveOutcome`, PATCH CAS, NAME_TAKEN | Task 5, Task 8 routes, Task 9 builder |
| §4.2 draft: changes, revision gate (pre-read base, ruling 4), `saveId` replay first — before the gates (ruling 3), STALE `{ revision }`, no key | Task 4, Task 8, Tasks 10a/10b client |
| §4.3 submit keyed, `canonicalJson`, `macHex`, stored / unstored codes, fill-page intent recovery (keyed ref) | Tasks 3, 4, 8, 10b |
| §4.4 versioning, snapshot at row creation, `formVersion` guard, carry + merge, "Not saved: …" | Tasks 2, 4, 10a, 10b; Task 12 (e) |
| §4.5 locking: L_req first in draft, submit, photo; erase locks the customer's requests first | Tasks 4, 6 |
| §5.1 who may fill (visit row, live visit, native window incl. own-row arm, synced), visit counts, gate SQL | Task 3 (ruling 1), Task 12 (f), (g), (m) |
| §5.2 draft steps, zero-row map, archived forms, Clear answers | Task 4, Task 10b, Task 12 (h) |
| §5.3 submit, `submit_key`, in-batch audit on status + key + xmin, takeover | Task 4, Task 12 (c) |
| §5.4 erase (lock, audit count in SQL, DELETE … RETURNING, answers last, request + equipment arms), photos after erase, own commit | Task 6, Task 12 (i) |
| §5.5 reopen | Task 5, Task 8, Task 11 UI, Task 12 (j) |
| §5.6 office writers, 100-form limit, UNKNOWN_JOB_TYPE, audits | Task 5, Task 8 |
| §6 routes, `frontGates` limit, `techFormDraft`, preamble, GET contracts, office routes | Task 8 (rulings 2, 3, 6, 8, 9) |
| §7.1 tab and builder (all copy, Undo, Discard changes, guard, archive confirm) | Task 9 |
| §7.2 Forms card (visit pick, chips, Add a form, filter above 10) | Tasks 10a (pure), 10b |
| §7.3 fill page (controls, ±, notes, touched/sent, autosave, status table, read-only reasons, merge, Clear answers, submit after a pending draft) | Tasks 10a (pure), 10b |
| §7.4 close-out reminder (blocked and ready, order, `reminderVisible`) | Tasks 10a, 10b |
| §7.5 office section (labels, chips, missing lines, Reopen confirm and STALE) | Task 11 |
| §7.6 Site (scope, payload, membership, card copy, page, estimate links for the lead only via the shared `isActiveLead`) | Tasks 3, 7, 11; Task 12 (l) |
| §7.7 photos (quality, resize steps, kept blob, Try again / Discard, PDF, 4 MB, route checks) | Task 6 (route), Task 11 (card) |
| §8 copy | Tasks 2, 4, 9, 10a, 11 (exact strings; plan-chosen copy listed in ruling 17) |
| §9 pure tests, SQL renders (incl. org counts on every builder, both batches' L_req and both UPDATEs' visit gate), route tests, integration (a)–(n) + v4.1 cascades + a foreign-org form + unassigned-from-a-row, browser walk | Tasks 1–11 (unit / render / route), Task 12 (integration), walks in Tasks 9, 10b, 11 |
| §11 not verified (Vercel 4.5 MB, iOS decode memory) | Task 12 memory note (deploy checklist) |
| §13 docs | Task 12 |

**2. Placeholder scan:** no TBD / "add appropriate" / "similar to Task N"; every code step carries the full file or an exact diff. Two places give edits as numbered snippets rather than a whole file (`tech-job-detail-client.tsx` in Tasks 10b and 11), because the file is shared between them.

**v2 changes after review round 1:** critic A-1 org-count / request-scope render assertions on `insertSubmissionSql` (7), the UPDATE (6), `cardFormsSql` (2), `countingVisitSql` (3), `oneSubmissionSql` (3), `submittedElsewhereSql` (4), `missingRequiredFormsSql` (6), the executed form reads and reopen's `service_request_id`, plus a foreign-org form in integration (f) and another request's id in (j); A-2 the submit batch's L_req and both UPDATEs' visit gate pinned, plus "unassigned from a visit that already has a row" in (f); A-3 the pre-read base (ruling 4; (c)'s insert-then-miss case now drives the writer's own statements); A-4 the cap measured and ruled unreachable (ruling 5); A-5 the substring PII-key rule; A-6 rejected in v2, then reversed by the lead in v3 (ruling 12); A-7 (m) built both ways (ruling 13); A-8 (a) no-row check, (f) `not_found`, (l) another location, the synced job's own estimate, unmatched estimates absent, member / non-member customers; A-9 erased-customer gate order (ruling 1); A-10 caveat recorded (ruling 15); A-11 replay before the gates (ruling 3). Critic B-M1 the address-less synced job is customer B's; B-M2 the fill page keyed and its recovery ref keyed; B-M3 submit after a pending draft (ruling 14, `submitStep`); B-m1 `dayShort`; m2 the Forms card's loading state; m3 the Reopen sentence not said twice; m4 the unreadable line not said twice; m5 straight apostrophe and plan-chosen copy listed (ruling 17); m6 walk 9's exact label; m7 the fixture's estimate options and walk 11's Reopen; m8 a failed re-read backs off; m9 a replay's failed GET re-read before PATCH; m10 an untouched New form isn't dirty; m11 Task 10 split into 10a / 10b (Task 8 kept whole); m12 the rerun-once note.

**v3 changes after the round-2 re-review:** ruling 12 reversed by the lead (`isLead` on the Site GET from the shared `isActiveLead`, links for the lead only, tests in Tasks 7 and 11); ruling cross-references renumbered and checked (code comments and plan text); ruling 3 says CUSTOMER_REMOVED is stored; the page-tech bullet carries the gate order and replay-first; a failed summary shows the Forms card's error state.

**3. Type consistency:** `FormWriteReason` (Task 4) is the key set of `FORM_REASON` and the input of `formReasonResult` / `formReasonResponse` (Task 8); `GateReason` (Task 3) ⊂ `FormWriteReason`; `WriteBlockedReason` (Task 3) is what `TechFormsView` / `TechFormView` carry (Task 7) and what `readOnlyCopy` takes (Task 10a); `submitStep` (Task 10a) drives `confirmSubmit` (Task 10b); `FormDefinition` (Task 2, readonly arrays) is what `createForm` / `updateForm` (Task 5), the route schemas (Task 8) and `toDefinition` (Task 9) exchange; `OfficeSubmission.visitState` is `'live' | 'ended'` in Task 5 and in `visitLabel` (Task 11); `SubmitBody` (Task 8) feeds `submitHashInput` and the integration `submitVia`; `SiteView` (Task 7) is what `siteCardLine` and the page read (Task 11); `TECH_UPLOAD_LIMIT_BYTES` is the one 4 MB constant for the route (Task 6), the PDF pick and the resize plan (Task 11).

**4. Review Focus:** five lines above, each pinned by a named test in the owning task (Tasks 2, 4, 5, 7, 8, 10a, 12).

**Accepted gaps (stated, not built):** photo upload and the resize drawing can't run on dev (no R2); the keyboard-open footer and `img.decode()` on a 48 MP capture need a real phone; the 4.5 MB body limit is measured on a preview after deploy.
