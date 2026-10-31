# Replica M0a: Schedule Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** M0b is merged (`ls drizzle/0047_*` shows the config-foundation migration; `schema.ts` already imports `check`, `unique`, `smallint`, `foreignKey`, `primaryKey`).

**Goal:** Add `en_route` / `arrived` to the request lifecycle, give every request an `appointments` row (visits, backfilled and kept in step by database triggers) with per-technician `appointment_assignments`, and let the office record technician time off / on-call / non-job events that every availability path respects.

**Architecture:** The request columns (`scheduled_date`, `arrival_window_start/end`, `assigned_to`, `status`) stay the source of truth for visit #1; two Postgres triggers (INSERT, and UPDATE with a `WHEN` clause) mirror them into `appointments` #1 and its lead assignment, so the 25 existing request-update sites, the FieldPulse/HCP sync, the AI booking path, the calendar and the KPIs are untouched. Visits #2+ are written only by `appointment-queries.ts`. The two new enum values are added in their own migration and the ~25 hard-coded status lists move onto shared constants without merging lists that differ today. Shifts are date-bound rows (no RRULE) subtracted in every availability path.

**Tech Stack:** Next.js 16, TypeScript, Drizzle ORM 0.45.2 + drizzle-kit 0.31 on Neon (neon-http, `db.batch()` only), plpgsql triggers, zod 4, vitest (pure helpers, mocked `@/lib/db`).

**Spec:** `replica/architecture.md` (Schema decisions 1–2, hard constraints, "M0 Foundation" API table, "The parts that bite" → Races, Status enum readers, Stand-in sessions; build-order item 3) and `replica/schema.sql` section "M0a". Companion: `replica/review-log.md`, `replica/design/components.md` ("Time-off editor").

## Global Constraints

Everything in the M0b plan's Global Constraints applies (gates, mocked tests, `isUniqueViolation` from `@/lib/db/unique-violation`, `readJsonBody`, `withTenant`, audit shape, copy canon, migration conventions and the six-step drizzle recipe, DB-probe recipe with `config({ path: ".env.local" })`, explicit `git add` lists, Fable attribution line, skills). Plus:

- Tech-app ownership stays `service_requests.assigned_to = session.userId` in M0a. Assignment rows grant nothing in the tech app.
- Byte-identical rule: an existing status list gets the new values added where they belong and is pointed at the constant whose members equal it; lists that differ today are NOT merged.
- Admin status changes go through `PATCH /api/admin/requests/<id>` with `{ "status": "<value>" }` (validated by `MANUAL_TARGET_STATUSES`). Tech session for curl: `TECH=$(npx tsx scripts/agent/mint-tech-session.mjs)` → cookie `hvac_tech_session=$TECH`. The script takes NO arguments: it signs the first `role='technician' AND is_active` user. Find that id first (`select id from users where role = 'technician' and is_active order by created_at limit 1` under the org `mint-admin-session` uses) and assign the probe request to it; tech screenshots: `node scripts/agent/screenshot-page.mjs <path> 390 <out> --tech`.
- Do not deploy between Task 1 and Task 2 (the tech list would drop `en_route` jobs until the readers learn the value).
- Time off is never overridable by "schedule anyway": a `removes_capacity` shift blocks placement even with `override`.

## Review Focus

1. Reassign A → B → A on one request → the lead row ends on A, no unique-key error, exactly one `is_lead` row. (Task 3 step 7.)
2. The FieldPulse nightly import re-writes identical values on every row → `appointments.version` does not change on any of them. (Task 3 step 7.)
3. A membership visit (date only, no window, no tech) → appointment #1 has `scheduled_date` set and `starts_at` NULL; it still lists as unscheduled. (Task 3 step 7.)
4. A technician on time off: window placement via `POST …/reschedule` (even with `override`), `POST …/assign` onto a windowed request, and the PATCH schedule path all → 409; auto-dispatch never picks them; public availability drops their capacity. (Task 6b step 7.)
5. A tech taps "On my way" → the request stays in their list, the admin sheet shows "En route", the AI account reply says it is on the way, the delay sweep still treats it as not started. (Task 2 step 6 + Task 4 step 3.)

---

## File map

| file | responsibility |
| --- | --- |
| `drizzle/0048_request_status_en_route.sql` | two `ADD VALUE`s only |
| `drizzle/0049_appointments_shifts.sql` | tables, triggers, backfill |
| `drizzle/meta/_journal.json`, `0048_snapshot.json`, `0049_snapshot.json` | journal + snapshots |
| `src/lib/db/schema.ts` | enum values, `appointments`, `appointmentAssignments`, `shiftKindEnum`, `technicianShifts` |
| `src/lib/admin/request-status.ts` (+ test) | TRANSITIONS edges, MANUAL_TARGET_STATUSES, seven shared constants |
| reader files (Task 2 table) | constants / values |
| `src/lib/admin/appointment-types.ts` (+ test), `appointment-queries.ts` | visits #2+ |
| `src/app/api/admin/requests/[id]/appointments/route.ts`, `…/[aid]/route.ts` | visits API |
| `src/components/admin/window-picker.tsx`, `request-create-dialog.tsx`, `request-detail-sheet.tsx` | "Visits" section |
| `src/lib/admin/shift-types.ts` (+ test), `shift-queries.ts` | shifts |
| `src/app/api/admin/technicians/[id]/shifts/route.ts`, `…/[sid]/route.ts` | shifts API |
| `src/components/admin/staff/time-off-dialog.tsx`, `src/components/admin/staff-table.tsx` | time-off editor |
| `src/lib/admin/scheduling-source.ts`, `src/lib/integrations/housecall-pro/scheduling-source.ts`, `src/lib/integrations/fieldpulse/scheduling-source.ts`, `src/lib/admin/availability-queries.ts` (+ test), `availability.test.ts`, `scheduling-queries.ts` | shifts subtracted |
| `.claude/skills/page-*/SKILL.md`, `replica/features.csv`, `replica/parity.md`, `replica/build-log.md` | docs |

---

### Task 1: Enum migration + status constants + transitions

**Files:**
- Modify: `src/lib/db/schema.ts` (`requestStatusEnum`), `src/lib/admin/request-status.ts`, `src/lib/admin/request-status.test.ts`, `src/components/admin/request-detail-sheet.tsx` (`STATUS_ACTION_LABELS: Record<ManualTargetStatus, string>` at ~line 56 fails to compile until the two labels exist)
- Create via the drizzle recipe: `drizzle/0048_request_status_en_route.sql`, `drizzle/meta/0048_snapshot.json`; modify `_journal.json`

**Interfaces (all exported from `@/lib/admin/request-status`):**
```ts
export const IN_FLIGHT_STATUSES = ["scheduled","assigned","en_route","arrived","in_progress","on_hold"] as const;
export const OPEN_STATUSES = ["pending", ...IN_FLIGHT_STATUSES] as const;
export const ON_SITE_STATUSES = ["arrived","in_progress"] as const;
export const NOT_STARTED_STATUSES = ["scheduled","assigned","en_route"] as const;
export const UNASSIGNED_OPEN_STATUSES = ["pending","scheduled"] as const;
export const NEEDS_PLACEMENT_STATUSES = ["pending","scheduled","assigned","en_route","arrived","in_progress"] as const;
export const TERMINAL_STATUSES = ["completed","cancelled"] as const;
export const MANUAL_TARGET_STATUSES = ["scheduled","en_route","arrived","in_progress","on_hold","completed","cancelled"] as const;  // replaces the existing declaration at ~lines 47–53
```

- [ ] **Step 1: `schema.ts`** — `requestStatusEnum` values become `["pending", "assigned", "en_route", "arrived", "scheduled", "in_progress", "on_hold", "completed", "cancelled"]` (this is the Postgres order after the two `AFTER` clauses). Drizzle recipe with `--name request_status_en_route`; overwrite the generated SQL with:

```sql
-- M0a: two new canonical job statuses for the tech loop. Own file: nothing
-- here USES the values. Precedent: 0001, 0008, 0013.
ALTER TYPE "public"."request_status" ADD VALUE IF NOT EXISTS 'en_route' AFTER 'assigned';
--> statement-breakpoint
ALTER TYPE "public"."request_status" ADD VALUE IF NOT EXISTS 'arrived' AFTER 'en_route';
```
Then `npx drizzle-kit generate` → "No schema changes".

- [ ] **Step 2: Failing tests** — in `request-status.test.ts` add `'en_route','arrived'` to the `vi.mock` enumValues, then append:

```ts
import { IN_FLIGHT_STATUSES, OPEN_STATUSES, ON_SITE_STATUSES, NOT_STARTED_STATUSES, TERMINAL_STATUSES } from './request-status';

describe('en_route / arrived', () => {
  it('tech taps follow assigned → en_route → arrived → in_progress', () => {
    expect(canTransition('assigned', 'en_route')).toBe(true);
    expect(canTransition('scheduled', 'en_route')).toBe(true);
    expect(canTransition('on_hold', 'en_route')).toBe(true);
    expect(canTransition('en_route', 'arrived')).toBe(true);
    expect(canTransition('en_route', 'in_progress')).toBe(true);
    expect(canTransition('en_route', 'scheduled')).toBe(true);
    expect(canTransition('arrived', 'in_progress')).toBe(true);
    expect(canTransition('arrived', 'completed')).toBe(false);
    expect(canTransition('en_route', 'completed')).toBe(false);
  });
  it('are manual targets', () => {
    expect(MANUAL_TARGET_STATUSES).toContain('en_route');
    expect(MANUAL_TARGET_STATUSES).toContain('arrived');
  });
  it('every enum value is in OPEN or TERMINAL, and the derived lists are subsets', () => {
    const all = ['pending','assigned','en_route','arrived','scheduled','in_progress','on_hold','completed','cancelled'];
    for (const s of all) expect([...OPEN_STATUSES, ...TERMINAL_STATUSES]).toContain(s);
    for (const s of IN_FLIGHT_STATUSES) expect(OPEN_STATUSES).toContain(s);
    for (const s of ON_SITE_STATUSES) expect(IN_FLIGHT_STATUSES).toContain(s);
    for (const s of NOT_STARTED_STATUSES) expect(IN_FLIGHT_STATUSES).toContain(s);
    expect(NOT_STARTED_STATUSES).toContain('en_route');
    expect(ON_SITE_STATUSES).not.toContain('en_route');
  });
});
```

- [ ] **Step 3: Run** `npx vitest run src/lib/admin/request-status.test.ts` → FAIL.

- [ ] **Step 4: Implement** in `request-status.ts`: replace `TRANSITIONS` and `MANUAL_TARGET_STATUSES`, add the constants:

```ts
const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  pending: ["scheduled", "cancelled"],
  scheduled: ["en_route", "in_progress", "on_hold", "cancelled"],
  assigned: ["scheduled", "en_route", "in_progress", "on_hold", "cancelled"],
  // Driving to the site. Can turn back (scheduled), arrive, start, pause, cancel.
  en_route: ["arrived", "in_progress", "scheduled", "on_hold", "cancelled"],
  // On site, not yet working. No arrived → completed: completion goes through
  // in_progress, and the response-time KPI is anchored on reaching the site.
  arrived: ["in_progress", "on_hold", "cancelled"],
  in_progress: ["on_hold", "completed", "cancelled"],
  on_hold: ["en_route", "in_progress", "scheduled", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export const MANUAL_TARGET_STATUSES = ["scheduled", "en_route", "arrived", "in_progress", "on_hold", "completed", "cancelled"] as const satisfies readonly RequestStatus[];

// ── Shared status lists (M0a) ────────────────────────────────────────────────
// One home for the lists that used to be hand-written in ~25 readers. Lists
// that differed before keep their own members; nothing is merged.
/** Booked through paused: somebody is working toward this request. */
export const IN_FLIGHT_STATUSES = ["scheduled", "assigned", "en_route", "arrived", "in_progress", "on_hold"] as const satisfies readonly RequestStatus[];
/** Non-terminal: IN_FLIGHT plus pending intake. */
export const OPEN_STATUSES = ["pending", ...IN_FLIGHT_STATUSES] as const satisfies readonly RequestStatus[];
/** The technician is physically at the site. */
export const ON_SITE_STATUSES = ["arrived", "in_progress"] as const satisfies readonly RequestStatus[];
/** Not yet on site (the delay sweep's "could still be late"). */
export const NOT_STARTED_STATUSES = ["scheduled", "assigned", "en_route"] as const satisfies readonly RequestStatus[];
/** Open and nobody owns it yet (dashboard "needs attention"). */
export const UNASSIGNED_OPEN_STATUSES = ["pending", "scheduled"] as const satisfies readonly RequestStatus[];
/** Can sit in the unscheduled sidebar when it has no arrival window. */
export const NEEDS_PLACEMENT_STATUSES = ["pending", "scheduled", "assigned", "en_route", "arrived", "in_progress"] as const satisfies readonly RequestStatus[];
export const TERMINAL_STATUSES = ["completed", "cancelled"] as const satisfies readonly RequestStatus[];
```
In `request-detail-sheet.tsx` add `en_route: 'Mark en route', arrived: 'Mark arrived'` to `STATUS_ACTION_LABELS`.

- [ ] **Step 5: Apply + gates + commit** — `npm run db:migrate` (dev); `npx drizzle-kit generate` → No schema changes; `npx tsc --noEmit` → 0; vitest ≥ baseline.
```bash
git add drizzle/0048_request_status_en_route.sql drizzle/meta/_journal.json drizzle/meta/0048_snapshot.json src/lib/db/schema.ts src/lib/admin/request-status.ts src/lib/admin/request-status.test.ts src/components/admin/request-detail-sheet.tsx
git commit -m "feat(status): en_route and arrived request statuses with shared status lists

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Point every status reader at the constants

**Files and the exact change (all verified against the code on 2026-11-01):**

| file | today | change |
| --- | --- | --- |
| `src/lib/admin/queries.ts:446` `OPEN_STATUSES`, `:454` `TERMINAL_STATUSES`, `:460` `UNASSIGNED_OPEN_STATUSES` | local consts | delete the locals; `import { OPEN_STATUSES, TERMINAL_STATUSES, UNASSIGNED_OPEN_STATUSES } from "./request-status"` (same members + the two new in OPEN) |
| `queries.ts:442` `ASSIGNABLE_STATUSES` | pending/scheduled/assigned | unchanged |
| `queries.ts:465` `REASSIGNABLE_STATUSES` | assigned/in_progress/on_hold | add `"en_route", "arrived"` (the 409 guard is M2) |
| `queries.ts:1068-1078` dashboard status buckets (CASE per status) | pending / assignedToday / inProgress / completedToday / scheduled / onHold | fold the new values into `inProgress`: `status IN ('en_route','arrived','in_progress')` with a comment "en route and arrived count as in progress on the dashboard tiles" — `DashboardStats` and the UI do not change |
| `src/lib/admin/scheduling-queries.ts:67` `ACTIVE_BOOKING_STATUSES` | 5 values | delete; import `OPEN_STATUSES` (identical members + new) and use it where the local was used |
| `scheduling-queries.ts:81` `UNSCHEDULED_STATUSES` | pending/scheduled/assigned/in_progress | delete; import `NEEDS_PLACEMENT_STATUSES` |
| `scheduling-queries.ts:721` raw SQL guard | `IN ('pending','assigned','scheduled','in_progress','on_hold')` | `IN ('pending','assigned','scheduled','en_route','arrived','in_progress','on_hold')` |
| `src/app/api/tech/jobs/route.ts:19` `ACTIVE_STATUSES` | scheduled/assigned/in_progress/on_hold | delete; import `IN_FLIGHT_STATUSES` |
| `src/app/api/admin/dispatch/map/route.ts:22` `ACTIVE_STATUSES` | same 4 | `IN_FLIGHT_STATUSES` |
| `src/lib/portal/portal-queries.ts:199` `ACTIVE_JOB_STATUSES` | 5 incl. pending | `OPEN_STATUSES` |
| `src/lib/ai/account-tools.ts:85` `UPCOMING_STATUSES` | 5 incl. pending | `OPEN_STATUSES` |
| `src/lib/ai/account-reply.ts:44` `statusLabel` + `appointmentReply` (~line 102) | default "being scheduled"; the label is interpolated into "Your appointment (REF) is … for <day> …" | add `case "en_route": return "on the way"; case "arrived": return "on site";` AND, in `appointmentReply` before the `day` branch, return early: `en_route` → "Your technician is on the way for <REF>." and `arrived` → "Your technician has arrived for <REF>." (so the sentence never reads "is on the way for Monday") |
| `src/lib/ai/dispatch/signals.ts:91` `SAME_DAY_LOAD_STATUSES` | 4 | add `"en_route", "arrived"` |
| `src/lib/dispatch/delay-detection.ts:17` `NOT_STARTED_STATUSES` | scheduled/assigned | delete; import `NOT_STARTED_STATUSES` (adds en_route) |
| `src/lib/admin/ops-insights-queries.ts:29` + raw SQL `:83` | pending/assigned/in_progress | add `en_route`, `arrived` in both (same spelling in the SQL literal); do NOT add scheduled/on_hold (pre-existing drift, out of scope) |
| `src/lib/admin/operations-metrics-queries.ts:160` | `eq(requestStatusEvents.toStatus, "in_progress")` | `inArray(requestStatusEvents.toStatus, [...ON_SITE_STATUSES])` (the SQL already takes `min(at)` per request; no JS change). Update the doc comment in `src/lib/admin/operations-metrics-types.ts` ~line 50: the clock now stops at arrival |
| `src/lib/admin/status-colors.ts:25,40` | 7 keys | BADGE: `en_route: 'bg-info-light text-info-strong border-info-border'`, `arrived: 'bg-success-light text-success-strong border-success-border'`; DOT: `en_route: 'bg-info'`, `arrived: 'bg-success'`. The `info` pair already passes the contrast test (used by `SESSION_STATUS_BADGE`); run `npx vitest run src/lib/admin/status-colors-contrast.test.ts` to confirm |
| `src/app/admin/(dashboard)/requests/page.tsx:47` whitelist | 7 | add `'en_route','arrived'` |
| `src/components/admin/request-filters.tsx:35` `STATUS_OPTIONS` | 7 | add `{ label: 'En route', value: 'en_route' }, { label: 'Arrived', value: 'arrived' }` after Assigned |
| `src/components/admin/insights/ops-insights-section.tsx:45` `STATUS_LABELS` | — | add `en_route: 'En route', arrived: 'Arrived'` |
| `src/lib/integrations/fieldpulse/import/jobs.ts:66` `FP_JOB_STATUS_MAP` | `"2": "assigned"` | `"2": "en_route"`; rewrite the comment above (FP stage 2 = "on the way"). The `on_hold` CASE at `:530` stays exactly as is. Known limitation to note in the commit: the nightly sync still rewrites a native `arrived`/`cancelled` on an FP-linked request back to FP's stage |
| `src/app/api/admin/integrations/fieldpulse/webhook/route.ts:94` | en_route/on_site → in_progress | `case "en_route": return "en_route"; case "on_site": return "arrived";` and widen the hand-written return union to `RequestStatus \| null` |
| `src/lib/integrations/housecall-pro/webhook-events.ts:118` | `job.on_my_way` → in_progress | `case "job.on_my_way": return "en_route";` (`job.started` stays in_progress); update the doc comment at ~105–110 |

**Tests to update in this task (they encode the old behaviour or mock too narrowly):**
- `src/lib/integrations/housecall-pro/webhook-events.test.ts:66` → `expect(eventTypeToStatus("job.on_my_way")).toBe("en_route")`.
- `src/lib/integrations/fieldpulse/import/jobs.test.ts:185-191` → rename to "maps statusInt 2 → en_route" and `toBe('en_route')`.
- `src/lib/dispatch/delay-detection.test.ts:37` schema mock → add `requestStatusEnum: { enumValues: [...9 values] }, holdReasonEnum: { enumValues: ['awaiting_parts','awaiting_customer','awaiting_access','weather','other'] }` (request-status.ts reads both at load). Add a case: an `en_route` job whose window end has passed is flagged late.
- `src/lib/admin/scheduling-queries.test.ts:69` mocks `./request-status` with only `isTerminal` → `vi.mock('./request-status', async (importOriginal) => ({ ...(await importOriginal()), isTerminal: … }))` or add the constants to the mock.
- `src/lib/ai/account-tools.test.ts` and `src/lib/admin/operations-metrics-queries.test.ts` schema mocks → add both enums.
- `src/lib/ai/bot-edge-cases-account.test.ts` → its `vi.mock("@/lib/db/schema", () => tables)` (~line 81) gains `requestStatusEnum` and `holdReasonEnum` (it imports `account-tools`, which now imports `request-status`); add assertions that `appointmentReply` for `status: "en_route"` contains "on the way" and for `arrived` contains "on site".
- `src/lib/admin/operations-metrics-queries.test.ts:81-94` mocks `drizzle-orm` without `inArray` → add it to the mock, and add `inArray` to the import at `operations-metrics-queries.ts:16`.
- Any other test whose schema mock lacks the enums will fail loudly at import; fix each by adding the two enums.

- [ ] **Step 1: Completeness grep**

Run: `grep -rnE "'(assigned|in_progress)'|\"(assigned|in_progress)\"" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.' | grep -v 'request-status.ts'`
Expected: every hit is in the table or is a `hold_reason`, FP-availability, type-literal or seed-demo context. Add any genuine miss to the table and fix it.

- [ ] **Step 2: Apply the table.** **Step 3: Update the tests listed.**

- [ ] **Step 4: Gates**

Run: `npx tsc --noEmit && npx eslint $(git diff --name-only | tr '\n' ' ') && npx vitest run 2>&1 | tail -3`

- [ ] **Step 5: FP histogram (done-when "identical except stage 2")**

Before and after running one FP import on dev (if FP credentials are configured on dev; otherwise skip and say so): `select status, count(*) from service_requests where fieldpulse_job_id is not null group by 1 order by 1`. Expected delta: only `assigned` → `en_route` moves.

- [ ] **Step 6: Probe (Review Focus 5, admin side)**

```bash
TOKEN=$(npx tsx scripts/agent/mint-admin-session.mjs); H='content-type: application/json'
RID=<an assigned request id>
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X PATCH http://localhost:3000/api/admin/requests/$RID -d '{"status":"en_route"}'; echo
curl -s -b "hvac_admin_session=$TOKEN" http://localhost:3000/api/admin/requests/$RID | grep -o '"status":"[a-z_]*"'      # en_route
curl -s -b "hvac_admin_session=$TOKEN" "http://localhost:3000/api/admin/requests?status=en_route" | grep -c "$RID"     # 1
TECH=$(npx tsx scripts/agent/mint-tech-session.mjs <assigned tech id>)
curl -s -b "hvac_tech_session=$TECH" http://localhost:3000/api/tech/jobs | grep -c "$RID"                              # 1
```
Screenshot `/admin/requests` at 1440 with the detail sheet showing "En route" (Playwright snippet from the M0b plan Task 8 step 8, clicking the request row).

- [ ] **Step 7: Commit** (explicit list):

```bash
git add src/lib/admin/queries.ts src/lib/admin/scheduling-queries.ts src/lib/admin/scheduling-queries.test.ts src/app/api/tech/jobs/route.ts src/app/api/admin/dispatch/map/route.ts src/lib/portal/portal-queries.ts src/lib/ai/account-tools.ts src/lib/ai/account-tools.test.ts src/lib/ai/account-reply.ts src/lib/ai/bot-edge-cases-account.test.ts src/lib/ai/dispatch/signals.ts src/lib/dispatch/delay-detection.ts src/lib/dispatch/delay-detection.test.ts src/lib/admin/ops-insights-queries.ts src/lib/admin/operations-metrics-queries.ts src/lib/admin/operations-metrics-queries.test.ts src/lib/admin/operations-metrics-types.ts src/lib/admin/status-colors.ts 'src/app/admin/(dashboard)/requests/page.tsx' src/components/admin/request-filters.tsx src/components/admin/insights/ops-insights-section.tsx src/lib/integrations/fieldpulse/import/jobs.ts src/lib/integrations/fieldpulse/import/jobs.test.ts src/app/api/admin/integrations/fieldpulse/webhook/route.ts src/lib/integrations/housecall-pro/webhook-events.ts src/lib/integrations/housecall-pro/webhook-events.test.ts
git commit -m "feat(status): every status reader learns en_route and arrived

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
(Add any further test file you had to touch.)

---

### Task 3: Appointments + assignments + shifts migration with triggers and backfill

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create via the drizzle recipe (`--name appointments_shifts`): `drizzle/0049_appointments_shifts.sql`, `drizzle/meta/0049_snapshot.json`; modify `_journal.json`

**Interfaces:** Drizzle tables `appointments`, `appointmentAssignments`, `technicianShifts`; enum `shiftKindEnum` (`on_call | time_off | non_job`).

- [ ] **Step 0: "Before" captures** (must run BEFORE the migration is applied; FP/HCP sync idle):

```bash
TOKEN=$(npx tsx scripts/agent/mint-admin-session.mjs); TECH=$(npx tsx scripts/agent/mint-tech-session.mjs); D=$(date +%F); S=/private/tmp/claude-501/-Users-sizbei-Documents-GitHub-ai-hvac-agent/fde8e78e-e26b-44a5-921c-c4bf61138d99/scratchpad/m0a
mkdir -p $S
curl -s -b "hvac_admin_session=$TOKEN" "http://localhost:3000/api/admin/calendar?date=$D&view=day" > $S/cal-day-before.json
curl -s -b "hvac_admin_session=$TOKEN" "http://localhost:3000/api/admin/calendar?date=$D&view=week&includeCompleted=true" > $S/cal-week-before.json
curl -s -b "hvac_admin_session=$TOKEN" "http://localhost:3000/api/admin/dispatch?date=$D" > $S/dispatch-before.json
curl -s -b "hvac_admin_session=$TOKEN" "http://localhost:3000/api/admin/calendar/unscheduled-count" > $S/unsched-before.json
curl -s -b "hvac_tech_session=$TECH" "http://localhost:3000/api/tech/jobs" > $S/tech-before.json
```

- [ ] **Step 1: `schema.ts`** (after `serviceRequests`):

```ts
export const shiftKindEnum = pgEnum("shift_kind", ["on_call", "time_off", "non_job"]);

// M0a: a visit. #1 is mirrored from the request by trigger (drizzle/0049);
// #2+ are written by appointment-queries.ts only. starts_at/ends_at = the
// arrival window; a date-only booking has scheduled_date and NULL starts_at.
export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    serviceRequestId: uuid("service_request_id").notNull().references(() => serviceRequests.id, { onDelete: "cascade" }),
    appointmentNumber: smallint("appointment_number").notNull().default(1),
    scheduledDate: timestamp("scheduled_date", { withTimezone: true }),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    arrivalWindowStart: timestamp("arrival_window_start", { withTimezone: true }),
    arrivalWindowEnd: timestamp("arrival_window_end", { withTimezone: true }),
    isConfirmed: boolean("is_confirmed").notNull().default(false),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    specialInstructions: text("special_instructions"),
    // Optimistic concurrency token (CAS on version, never on updated_at).
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("appointments_request_number_unique").on(table.serviceRequestId, table.appointmentNumber),
    check("appointments_window_check", sql`${table.arrivalWindowEnd} IS NULL OR ${table.arrivalWindowStart} IS NULL OR ${table.arrivalWindowEnd} > ${table.arrivalWindowStart}`),
    check("appointments_span_check", sql`${table.endsAt} IS NULL OR ${table.startsAt} IS NULL OR ${table.endsAt} >= ${table.startsAt}`),
    index("appointments_org_starts_at_idx").on(table.organizationId, table.startsAt),
    index("appointments_request_idx").on(table.serviceRequestId),
  ],
);

// M0a: who is on a visit. One lead per visit; status uses the request enum so
// there is one vocabulary. Progress timestamps are written by M3.
export const appointmentAssignments = pgTable(
  "appointment_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id").notNull().references(() => appointments.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    isLead: boolean("is_lead").notNull().default(false),
    status: requestStatusEnum("status").notNull().default("assigned"),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
    enRouteAt: timestamp("en_route_at", { withTimezone: true }),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("appointment_assignments_unique").on(table.appointmentId, table.technicianId),
    uniqueIndex("appointment_assignments_one_lead_idx").on(table.appointmentId).where(sql`${table.isLead} = true`),
    index("appointment_assignments_tech_appt_idx").on(table.technicianId, table.appointmentId),
    index("appointment_assignments_org_tech_idx").on(table.organizationId, table.technicianId),
  ],
);

// M0a: date-bound exceptions to technician_availability (on call, time off,
// non-job events). No RRULE: a repeating absence is N rows.
export const technicianShifts = pgTable(
  "technician_shifts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: shiftKindEnum("kind").notNull(),
    title: text("title"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    removesCapacity: boolean("removes_capacity").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("technician_shifts_order_check", sql`${table.endsAt} > ${table.startsAt}`),
    index("technician_shifts_org_tech_starts_idx").on(table.organizationId, table.technicianId, table.startsAt),
  ],
);
```

- [ ] **Step 2: Generate** with `--name appointments_shifts`, compare objects, then overwrite the SQL with:

```sql
-- M0a schedule foundation: appointments (visits) + per-technician assignments,
-- mirrored from service_requests by trigger, backfilled; technician shifts.
-- Idempotent throughout (see replica/schema.sql header).
CREATE TABLE IF NOT EXISTS "appointments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "service_request_id" uuid NOT NULL,
  "appointment_number" smallint DEFAULT 1 NOT NULL,
  "scheduled_date" timestamp with time zone,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "arrival_window_start" timestamp with time zone,
  "arrival_window_end" timestamp with time zone,
  "is_confirmed" boolean DEFAULT false NOT NULL,
  "cancelled_at" timestamp with time zone,
  "special_instructions" text,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "appointments_request_number_unique" UNIQUE("service_request_id","appointment_number"),
  CONSTRAINT "appointments_window_check" CHECK ("appointments"."arrival_window_end" IS NULL OR "appointments"."arrival_window_start" IS NULL OR "appointments"."arrival_window_end" > "appointments"."arrival_window_start"),
  CONSTRAINT "appointments_span_check" CHECK ("appointments"."ends_at" IS NULL OR "appointments"."starts_at" IS NULL OR "appointments"."ends_at" >= "appointments"."starts_at")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_org_starts_at_idx" ON "appointments" USING btree ("organization_id","starts_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_request_idx" ON "appointments" USING btree ("service_request_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "appointment_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "appointment_id" uuid NOT NULL,
  "technician_id" uuid NOT NULL,
  "is_lead" boolean DEFAULT false NOT NULL,
  "status" "request_status" DEFAULT 'assigned' NOT NULL,
  "assigned_by" uuid,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "en_route_at" timestamp with time zone,
  "arrived_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "appointment_assignments_unique" UNIQUE("appointment_id","technician_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "appointment_assignments" ADD CONSTRAINT "appointment_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "appointment_assignments" ADD CONSTRAINT "appointment_assignments_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "appointment_assignments" ADD CONSTRAINT "appointment_assignments_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "appointment_assignments" ADD CONSTRAINT "appointment_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_assignments_one_lead_idx" ON "appointment_assignments" USING btree ("appointment_id") WHERE "appointment_assignments"."is_lead" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointment_assignments_tech_appt_idx" ON "appointment_assignments" USING btree ("technician_id","appointment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointment_assignments_org_tech_idx" ON "appointment_assignments" USING btree ("organization_id","technician_id");
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."shift_kind" AS ENUM('on_call', 'time_off', 'non_job');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "technician_shifts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "technician_id" uuid NOT NULL,
  "kind" "shift_kind" NOT NULL,
  "title" text,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "removes_capacity" boolean DEFAULT true NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "technician_shifts_order_check" CHECK ("technician_shifts"."ends_at" > "technician_shifts"."starts_at")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "technician_shifts" ADD CONSTRAINT "technician_shifts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "technician_shifts" ADD CONSTRAINT "technician_shifts_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "technician_shifts" ADD CONSTRAINT "technician_shifts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "technician_shifts_org_tech_starts_idx" ON "technician_shifts" USING btree ("organization_id","technician_id","starts_at");
--> statement-breakpoint
-- Request -> appointment #1 (+ lead assignment). The request columns stay the
-- source of truth for visit #1; this mirrors them. Rules: replica/schema.sql M0a.
CREATE OR REPLACE FUNCTION sync_request_appointment()
RETURNS TRIGGER AS $$
DECLARE
  v_appt_id uuid;
  v_window_end timestamptz;
  v_old_assigned uuid;
  v_has_progress boolean;
BEGIN
  v_old_assigned := CASE WHEN TG_OP = 'UPDATE' THEN OLD.assigned_to ELSE NULL END;

  -- 0. Cancelling the request cancels every visit (frees the calendar and
  --    capacity). Runs first so it also covers requests with no visit #1.
  IF NEW.status = 'cancelled' THEN
    UPDATE appointments SET cancelled_at = COALESCE(cancelled_at, now()),
        version = version + 1, updated_at = now()
      WHERE service_request_id = NEW.id AND cancelled_at IS NULL;
  END IF;

  -- 1. Nothing to mirror: delete #1 when it has no progress, else null its
  --    times and demote the lead.
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
      ) INTO v_has_progress;
      IF NOT v_has_progress THEN
        DELETE FROM appointments WHERE id = v_appt_id;
      ELSE
        UPDATE appointments
          SET scheduled_date = NULL, starts_at = NULL, ends_at = NULL,
              arrival_window_start = NULL, arrival_window_end = NULL,
              version = version + 1, updated_at = now()
          WHERE id = v_appt_id;
        UPDATE appointment_assignments SET is_lead = false, status = 'cancelled'
          WHERE appointment_id = v_appt_id AND is_lead;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- A window whose end is not after its start is treated as no end.
  v_window_end := CASE
    WHEN NEW.arrival_window_end IS NOT NULL AND NEW.arrival_window_start IS NOT NULL
         AND NEW.arrival_window_end <= NEW.arrival_window_start THEN NULL
    ELSE NEW.arrival_window_end END;

  -- 2. Upsert visit #1. starts_at/ends_at come from the window ONLY: a
  --    date-only booking keeps starts_at NULL (it is "unscheduled" today).
  --    cancelled_at follows the request: the FieldPulse import can reopen a
  --    cancelled request, so a non-cancelled status clears it on #1.
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
      cancelled_at = CASE WHEN NEW.status = 'cancelled'
                          THEN COALESCE(appointments.cancelled_at, now()) ELSE NULL END,
      version = appointments.version + 1,
      updated_at = now()
  RETURNING id INTO v_appt_id;

  -- 3. Lead assignment follows assigned_to.
  IF TG_OP = 'INSERT' OR v_old_assigned IS DISTINCT FROM NEW.assigned_to THEN
    -- Old lead (different tech, or no tech now): delete when it never
    -- progressed, otherwise keep it demoted and cancelled (history).
    DELETE FROM appointment_assignments a
      WHERE a.appointment_id = v_appt_id AND a.is_lead
        AND (NEW.assigned_to IS NULL OR a.technician_id <> NEW.assigned_to)
        AND a.en_route_at IS NULL AND a.arrived_at IS NULL
        AND a.started_at IS NULL AND a.completed_at IS NULL;
    UPDATE appointment_assignments a SET is_lead = false, status = 'cancelled'
      WHERE a.appointment_id = v_appt_id AND a.is_lead
        AND (NEW.assigned_to IS NULL OR a.technician_id <> NEW.assigned_to);
    IF NEW.assigned_to IS NOT NULL THEN
      INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id,
          is_lead, status, assigned_at)
      VALUES (NEW.organization_id, v_appt_id, NEW.assigned_to, true, NEW.status, now())
      ON CONFLICT (appointment_id, technician_id) DO UPDATE SET
          is_lead = true, status = EXCLUDED.status;   -- A -> B -> A works
    END IF;
  ELSIF NEW.assigned_to IS NOT NULL THEN
    -- 4. Status mirror for the lead (single-tech jobs stay in step).
    UPDATE appointment_assignments SET status = NEW.status
      WHERE appointment_id = v_appt_id AND technician_id = NEW.assigned_to AND is_lead;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS service_requests_sync_appointment_ins ON service_requests;
--> statement-breakpoint
CREATE TRIGGER service_requests_sync_appointment_ins
  AFTER INSERT ON service_requests
  FOR EACH ROW EXECUTE FUNCTION sync_request_appointment();
--> statement-breakpoint
DROP TRIGGER IF EXISTS service_requests_sync_appointment_upd ON service_requests;
--> statement-breakpoint
-- UPDATE OF fires on unchanged values (the FieldPulse sync rewrites every row
-- nightly), so the WHEN clause limits it to real changes.
CREATE TRIGGER service_requests_sync_appointment_upd
  AFTER UPDATE OF scheduled_date, arrival_window_start, arrival_window_end, assigned_to, status
  ON service_requests
  FOR EACH ROW
  WHEN (OLD.scheduled_date IS DISTINCT FROM NEW.scheduled_date
     OR OLD.arrival_window_start IS DISTINCT FROM NEW.arrival_window_start
     OR OLD.arrival_window_end IS DISTINCT FROM NEW.arrival_window_end
     OR OLD.assigned_to IS DISTINCT FROM NEW.assigned_to
     OR OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION sync_request_appointment();
--> statement-breakpoint
-- Backfill visit #1 for every request that has a date, a window or a tech.
-- Same formulas as the function; idempotent via NOT EXISTS.
INSERT INTO appointments (organization_id, service_request_id, appointment_number,
    scheduled_date, starts_at, ends_at, arrival_window_start, arrival_window_end,
    cancelled_at, created_at)
SELECT r.organization_id, r.id, 1, r.scheduled_date,
    r.arrival_window_start,
    CASE WHEN r.arrival_window_end IS NOT NULL AND r.arrival_window_start IS NOT NULL
              AND r.arrival_window_end <= r.arrival_window_start THEN NULL ELSE r.arrival_window_end END,
    r.arrival_window_start,
    CASE WHEN r.arrival_window_end IS NOT NULL AND r.arrival_window_start IS NOT NULL
              AND r.arrival_window_end <= r.arrival_window_start THEN NULL ELSE r.arrival_window_end END,
    CASE WHEN r.status = 'cancelled' THEN r.updated_at ELSE NULL END,
    r.created_at
FROM service_requests r
WHERE (r.scheduled_date IS NOT NULL OR r.arrival_window_start IS NOT NULL
       OR r.arrival_window_end IS NOT NULL OR r.assigned_to IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.service_request_id = r.id AND a.appointment_number = 1);
--> statement-breakpoint
INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id, is_lead, status, assigned_at)
SELECT r.organization_id, a.id, r.assigned_to, true, r.status, r.updated_at
FROM service_requests r
JOIN appointments a ON a.service_request_id = r.id AND a.appointment_number = 1
WHERE r.assigned_to IS NOT NULL
ON CONFLICT ("appointment_id","technician_id") DO NOTHING;
```

- [ ] **Step 3:** `npx drizzle-kit generate` → "No schema changes".

- [ ] **Step 4: Pre-flight, then apply twice**

DB probe: `select (select count(*) from service_requests where arrival_window_end <= arrival_window_start) as bad_windows, (select count(*) from service_requests where scheduled_date is not null or arrival_window_start is not null or arrival_window_end is not null or assigned_to is not null) as to_backfill;`
Run: `npm run db:migrate && npm run db:migrate` → both succeed.

- [ ] **Step 5: Done-when checks**

```sql
select (select count(*) from service_requests where scheduled_date is not null or arrival_window_start is not null or arrival_window_end is not null or assigned_to is not null) as expected,
       (select count(*) from appointments where appointment_number = 1) as actual;
-- columns match
select count(*) from service_requests r join appointments a on a.service_request_id = r.id and a.appointment_number = 1
 where a.scheduled_date is distinct from r.scheduled_date or a.arrival_window_start is distinct from r.arrival_window_start
    or (r.assigned_to is not null and not exists (select 1 from appointment_assignments x where x.appointment_id = a.id and x.technician_id = r.assigned_to and x.is_lead));
-- never more than one lead
select appointment_id from appointment_assignments where is_lead group by 1 having count(*) > 1;
```
Expected: `expected = actual`; `0`; no rows.

- [ ] **Step 6: "After" captures and diff**

Re-run the Step 0 curls into `*-after.json` and `diff` each pair. Expected: no diff (the calendar/dispatch/tech payloads carry no generated timestamps; if one does, strip it with `jq 'del(.data.generatedAt)'` and note it).

- [ ] **Step 7: Trigger behaviour probes (Review Focus 1–3)** — create a throwaway request via `POST /api/admin/requests` with `customerId` and no schedule; then run via the DB probe recipe (one statement per `sql` call):

```sql
-- (1) A -> B -> A
update service_requests set assigned_to = '<techA>' where id = '<rid>';
update service_requests set assigned_to = '<techB>' where id = '<rid>';
update service_requests set assigned_to = '<techA>' where id = '<rid>';
select technician_id, is_lead, status from appointment_assignments where appointment_id = (select id from appointments where service_request_id = '<rid>' and appointment_number = 1);
-- expect exactly one row: techA, true, pending
-- (2) FP-style identical rewrite: version unchanged
select version from appointments where service_request_id = '<rid>' and appointment_number = 1;
update service_requests set status = case when status = 'on_hold' then status else 'pending'::request_status end, assigned_to = assigned_to, scheduled_date = scheduled_date, arrival_window_start = arrival_window_start, arrival_window_end = arrival_window_end, updated_at = now() where id = '<rid>';
select version from appointments where service_request_id = '<rid>' and appointment_number = 1;   -- same
-- (3) date-only: starts_at null, scheduled_date set
update service_requests set arrival_window_start = null, arrival_window_end = null, scheduled_date = now() + interval '3 days' where id = '<rid>';
select scheduled_date, starts_at from appointments where service_request_id = '<rid>' and appointment_number = 1;
-- (4) cancel cascade with a request that has NO visit #1: new throwaway request <rid2>, insert a visit #2 by hand:
insert into appointments (organization_id, service_request_id, appointment_number, arrival_window_start, arrival_window_end, starts_at, ends_at) values ('<org>', '<rid2>', 2, now() + interval '5 days', now() + interval '5 days 4 hours', now() + interval '5 days', now() + interval '5 days 4 hours');
update service_requests set status = 'cancelled' where id = '<rid2>';
select appointment_number, cancelled_at is not null from appointments where service_request_id = '<rid2>';   -- (2, true)
-- (5) unschedule: row deleted
update service_requests set scheduled_date = null, assigned_to = null where id = '<rid>';
select count(*) from appointments where service_request_id = '<rid>';   -- 0
```
Record the outputs in the commit body; delete the throwaway requests afterwards (`delete from service_requests where id in (...)`).

- [ ] **Step 8: Gates + commit**

```bash
git add drizzle/0049_appointments_shifts.sql drizzle/meta/_journal.json drizzle/meta/0049_snapshot.json src/lib/db/schema.ts
git commit -m "feat(db): appointments, assignments and shifts; visit #1 mirrored by trigger and backfilled

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Tech taps "On my way" / "I've arrived"

**Files:**
- Modify: `src/components/tech/tech-status-confirm.ts` (already holds `buildStatusConfirmCopy` and `isTerminalStatus`; add `techStatusLabel`), its test file (create `tech-status-confirm.test.ts` if none), `src/components/tech/tech-job-summary.tsx` (use `techStatusLabel(s)` instead of `humanize(s)` for the buttons)
- No change: `src/app/api/tech/jobs/[id]/status/route.ts` (its zod enum is `MANUAL_TARGET_STATUSES`), `src/lib/tech/field-queries.ts` (`allowedNextStatuses` derives from `allowedTransitions` filtered by the manual list at ~110–113)

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { techStatusLabel } from "./tech-status-confirm";
describe("techStatusLabel", () => {
  it("gives field wording to the new taps and keeps humanized defaults", () => {
    expect(techStatusLabel("en_route")).toBe("On my way");
    expect(techStatusLabel("arrived")).toBe("I've arrived");
    expect(techStatusLabel("in_progress")).toBe("In progress");
    expect(techStatusLabel("completed")).toBe("Completed");
  });
});
```

- [ ] **Step 2: Implement**

```ts
const TECH_STATUS_LABELS: Record<string, string> = { en_route: "On my way", arrived: "I've arrived" };
export function techStatusLabel(status: string): string {
  return TECH_STATUS_LABELS[status] ?? status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
```
Use it in `tech-job-summary.tsx`'s button text. Confirm `buildStatusConfirmCopy`/`isTerminalStatus` key only on completed/cancelled (no confirm for the new taps).

- [ ] **Step 3: Probe (Review Focus 5, tech side)**

```bash
RID=<request assigned to the technician mint-tech-session signs>; TECH=$(npx tsx scripts/agent/mint-tech-session.mjs); H='content-type: application/json'
curl -s -b "hvac_tech_session=$TECH" -H "$H" -X POST http://localhost:3000/api/tech/jobs/$RID/status -d '{"status":"en_route"}'; echo    # 200
curl -s -b "hvac_tech_session=$TECH" http://localhost:3000/api/tech/jobs | grep -c "$RID"                                           # 1
curl -s -b "hvac_tech_session=$TECH" -H "$H" -X POST http://localhost:3000/api/tech/jobs/$RID/status -d '{"status":"arrived"}'; echo     # 200
curl -s -b "hvac_tech_session=$TECH" -H "$H" -X POST http://localhost:3000/api/tech/jobs/$RID/status -d '{"status":"completed"}'; echo   # 409 INVALID_TRANSITION
curl -s -b "hvac_tech_session=$TECH" -H "$H" -X POST http://localhost:3000/api/tech/jobs/$RID/status -d '{"status":"in_progress"}'; echo # 200
```
`node scripts/agent/screenshot-page.mjs /tech/jobs/$RID 390 /tmp/tech-en-route.png --tech` after the en_route step (re-run the sequence) and look at it.

- [ ] **Step 4: Gates + commit**

```bash
git add src/components/tech/tech-status-confirm.ts src/components/tech/tech-status-confirm.test.ts src/components/tech/tech-job-summary.tsx
git commit -m "feat(tech): on my way and arrived taps

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5a: Visits #2+ — types, queries, API

**Files:**
- Create: `src/lib/admin/appointment-types.ts` (+ `.test.ts`), `src/lib/admin/appointment-queries.ts`
- Create: `src/app/api/admin/requests/[id]/appointments/route.ts` (GET, POST), `…/appointments/[aid]/route.ts` (PATCH, DELETE = cancel). Copy the route shape from `src/app/api/admin/settings/faqs/route.ts`.

**Interfaces:**
- `appointment-types.ts` (client-safe):
  ```ts
  export interface AppointmentAssignmentRecord { technicianId: string; technicianName: string; isLead: boolean; status: string }
  export interface AppointmentRecord { id; serviceRequestId; appointmentNumber: number; scheduledDate: string|null; startsAt: string|null; endsAt: string|null; arrivalWindowStart: string|null; arrivalWindowEnd: string|null; isConfirmed: boolean; cancelledAt: string|null; specialInstructions: string|null; version: number; assignments: readonly AppointmentAssignmentRecord[] }
  export const appointmentInputSchema  // arrivalWindowStart: z.iso.datetime(), arrivalWindowEnd: z.iso.datetime(), technicianIds: z.array(uuid).min(1).max(5), specialInstructions ≤1000; refine end > start
  export const appointmentPatchSchema = appointmentInputSchema.extend({ version: z.number().int().min(0) })
  export function nextAppointmentNumber(existing: readonly { appointmentNumber: number }[]): number   // max + 1, min 2
  export function windowIsValid(start: string, end: string): boolean
  ```
- `appointment-queries.ts`: `listAppointments(orgId, requestId)`, `addAppointment(orgId, requestId, input, actorUserId) → AppointmentRecord | { reason: "request_not_found" | "technician_not_found" | "conflict" }`, `updateAppointment(orgId, requestId, appointmentId, patch, actorUserId) → AppointmentRecord | { reason: "not_found" | "version_conflict" | "is_first_visit" | "technician_not_found" }`, `cancelAppointment(orgId, requestId, appointmentId, version) → { ok: true } | { reason: "not_found" | "version_conflict" | "is_first_visit" }`.
- Visit #1 is read-only through this API (409 `IS_FIRST_VISIT` "Edit the first visit from the request itself."). Technician ids are re-read as `role = 'technician' AND is_active` under the org (copy the check from `reassignTechnician`, `queries.ts:616-630`).

- [ ] **Step 1: Failing tests** (pure) for `nextAppointmentNumber([]) === 2`, `nextAppointmentNumber([{1},{2}]) === 3`, `windowIsValid` (end ≤ start → false), `appointmentInputSchema` rejects 6 technicians and end-before-start, `appointmentPatchSchema` requires `version`.

- [ ] **Step 2: Implement the queries.** The race-safe shapes (neon-http: each `db.batch` is one implicit transaction; statements outside it are not):

```ts
// addAppointment — number allocation can race on appointments_request_number_unique; retry once.
export async function addAppointment(organizationId: string, requestId: string, input: AppointmentInput, actorUserId: string) {
  if (!(await requestExists(organizationId, requestId))) return { reason: "request_not_found" } as const;
  const ordered = [...new Set(input.technicianIds)];                               // the caller's order decides the lead
  const found = await activeTechnicianIds(organizationId, ordered);                 // withTenant(users, org, inArray(users.id, ids), eq(users.role,"technician"), eq(users.isActive,true)) — returns ids in DB order
  if (found.length !== ordered.length) return { reason: "technician_not_found" } as const;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await db.select({ appointmentNumber: appointments.appointmentNumber }).from(appointments)
      .where(withTenant(appointments, organizationId, eq(appointments.serviceRequestId, requestId)));
    const appointmentNumber = nextAppointmentNumber(existing);
    const id = randomUUID();
    const start = new Date(input.arrivalWindowStart), end = new Date(input.arrivalWindowEnd);
    try {
      await db.batch([
        db.insert(appointments).values({ id, organizationId, serviceRequestId: requestId, appointmentNumber, startsAt: start, endsAt: end,
          arrivalWindowStart: start, arrivalWindowEnd: end, specialInstructions: input.specialInstructions ?? null }),
        db.insert(appointmentAssignments).values(ordered.map((technicianId, i) => ({ organizationId, appointmentId: id, technicianId, isLead: i === 0, status: "assigned" as const, assignedBy: actorUserId }))),
      ]);
      return (await getAppointment(organizationId, requestId, id))!;
    } catch (error: unknown) {
      if (isUniqueViolation(error, "appointments_request_number_unique") && attempt === 0) continue;
      if (isUniqueViolation(error)) return { reason: "conflict" } as const;
      throw error;
    }
  }
  return { reason: "conflict" } as const;
}

// updateAppointment — ONE batch (one implicit transaction on neon-http): CAS update +
// assignment delete + assignment insert. The latter two are gated on "THIS transaction
// wrote the appointment row" (xmin = current xid), not on version = v + 1: under READ
// COMMITTED a loser whose CAS matched 0 rows would otherwise see the winner's v + 1 and
// replace the winner's technicians.
export async function updateAppointment(organizationId: string, requestId: string, appointmentId: string, patch: AppointmentPatch, actorUserId: string) {
  const ordered = [...new Set(patch.technicianIds)];
  const found = await activeTechnicianIds(organizationId, ordered);
  if (found.length !== ordered.length) return { reason: "technician_not_found" } as const;
  const start = new Date(patch.arrivalWindowStart), end = new Date(patch.arrivalWindowEnd);
  const landed = sql`EXISTS (SELECT 1 FROM ${appointments} p WHERE p.id = ${appointmentId}::uuid AND p.organization_id = ${organizationId}::uuid AND p.xmin = pg_current_xact_id()::xid)`;
  const [updated] = await db.batch([
    db.update(appointments).set({ startsAt: start, endsAt: end, arrivalWindowStart: start, arrivalWindowEnd: end,
        specialInstructions: patch.specialInstructions ?? null, version: sql`${appointments.version} + 1`, updatedAt: new Date() })
      .where(withTenant(appointments, organizationId, eq(appointments.id, appointmentId), eq(appointments.serviceRequestId, requestId),
        eq(appointments.version, patch.version), gt(appointments.appointmentNumber, 1)))
      .returning({ id: appointments.id }),
    db.delete(appointmentAssignments).where(withTenant(appointmentAssignments, organizationId, eq(appointmentAssignments.appointmentId, appointmentId), landed)),
    db.execute(sql`INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id, is_lead, status, assigned_by)
      SELECT ${organizationId}::uuid, ${appointmentId}::uuid, t.id, t.ord = 1, 'assigned'::request_status, ${actorUserId}::uuid
      FROM unnest(${sql.param(ordered)}::uuid[]) WITH ORDINALITY AS t(id, ord) WHERE ${landed}`),
  ]);
  if (updated.length === 0) {
    const [row] = await db.select({ n: appointments.appointmentNumber }).from(appointments)
      .where(withTenant(appointments, organizationId, eq(appointments.id, appointmentId), eq(appointments.serviceRequestId, requestId))).limit(1);
    if (!row) return { reason: "not_found" } as const;
    if (row.n === 1) return { reason: "is_first_visit" } as const;
    return { reason: "version_conflict" } as const;
  }
  return (await getAppointment(organizationId, requestId, appointmentId))!;
}

// cancelAppointment — same CAS + the same xmin gate; also sets its assignments to 'cancelled' in the same batch.
```
(`gt` from drizzle-orm. `sql.param(ordered)` renders one `$n::uuid[]` parameter and the neon driver serialises the JS array as a Postgres array literal; a bare `${ordered}` would expand to `($1, $2)` and fail. Never build the list with `sql.raw`.) `listAppointments` joins `users` for `technicianName`, orders by `appointmentNumber`.

- [ ] **Step 3: Routes.** `POST …/appointments` → 201; `PATCH …/[aid]` body `appointmentPatchSchema`; `DELETE …/[aid]` body `{ version }`. Map reasons: `version_conflict` → 409 `VERSION_CONFLICT` "This visit changed. Reload and try again."; `is_first_visit` → 409 `IS_FIRST_VISIT`; `technician_not_found` → 400; `conflict` → 409 `CONFLICT` "Couldn't add the visit. Try again."; `request_not_found`/`not_found` → 404. Audit `add_appointment` / `update_appointment` / `cancel_appointment`, entity `appointments`, details `{ serviceRequestId, appointmentNumber, technicianIds }`.

- [ ] **Step 4: Probe**

```bash
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X POST http://localhost:3000/api/admin/requests/$RID/appointments -d '{"arrivalWindowStart":"2026-11-10T13:00:00Z","arrivalWindowEnd":"2026-11-10T17:00:00Z","technicianIds":["<techA>"]}'; echo   # 201, appointmentNumber 2
AID=<id>; V=<version>
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X PATCH http://localhost:3000/api/admin/requests/$RID/appointments/$AID -d "{\"arrivalWindowStart\":\"2026-11-11T13:00:00Z\",\"arrivalWindowEnd\":\"2026-11-11T17:00:00Z\",\"technicianIds\":[\"<techB>\"],\"version\":$V}"; echo   # 200, version V+1, assignments = [B lead]
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X PATCH http://localhost:3000/api/admin/requests/$RID/appointments/$AID -d "{\"arrivalWindowStart\":\"2026-11-11T13:00:00Z\",\"arrivalWindowEnd\":\"2026-11-11T17:00:00Z\",\"technicianIds\":[\"<techB>\"],\"version\":$V}"; echo   # 409 VERSION_CONFLICT (stale)
A1=<appointment #1 id>
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X DELETE http://localhost:3000/api/admin/requests/$RID/appointments/$A1 -d '{"version":0}'; echo   # 409 IS_FIRST_VISIT
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X PATCH http://localhost:3000/api/admin/requests/$RID -d '{"status":"cancelled"}'; echo
curl -s -b "hvac_admin_session=$TOKEN" http://localhost:3000/api/admin/requests/$RID/appointments | grep -o '"cancelledAt":"[^"]*"' | wc -l   # 2
```

- [ ] **Step 5: Gates + commit**

```bash
git add src/lib/admin/appointment-types.ts src/lib/admin/appointment-types.test.ts src/lib/admin/appointment-queries.ts 'src/app/api/admin/requests/[id]/appointments'
git commit -m "feat(requests): additional visits with per-technician assignments

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5b: "Visits" on the request detail sheet

**Files:**
- Create: `src/components/admin/window-picker.tsx` — extract the day-chip + window-chip + technician select block from `src/components/admin/request-create-dialog.tsx` (the "Schedule now" section) into a reusable component with props `{ value: { isoDay, window, technicianId } | null; onChange; availability: OpenWindow[]; technicians }`; the dialog then uses it (unconditional extraction).
- Modify: `src/components/admin/request-create-dialog.tsx`, `src/components/admin/request-detail-sheet.tsx`

- [ ] **Step 1:** Extract `WindowPicker`; the dialog's behaviour is unchanged (re-run the M0b Task 8 dialog screenshot and compare).
- [ ] **Step 2:** In the detail sheet add a `SectionCard` "Visits": rows "#n · <day> <window> · <tech names> · Confirmed / Cancelled"; visit #1 labelled "(from the request)" and read-only; "Add visit" opens a `Dialog` with `WindowPicker` (a window chip resolves to the band's start/end instants via the same helper the dialog uses) + a technician multi-select (first = lead); per-visit (#2+) "Cancel visit" with `ConfirmDialog` sending `{ version }`; 409 `VERSION_CONFLICT` → refetch + "This visit changed. Reload and try again."
- [ ] **Step 3:** Screenshot the sheet with two visits at 1440 (Playwright snippet, click the request row). Look at it.
- [ ] **Step 4: Gates + commit**

```bash
git add src/components/admin/window-picker.tsx src/components/admin/request-create-dialog.tsx src/components/admin/request-detail-sheet.tsx
git commit -m "feat(requests): visits section on the detail sheet with a shared window picker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6a: Shifts — types, queries, API

**Files:**
- Create: `src/lib/admin/shift-types.ts` (+ `.test.ts`), `src/lib/admin/shift-queries.ts`
- Create: `src/app/api/admin/technicians/[id]/shifts/route.ts` (GET `?from=&to=`, POST), `…/shifts/[sid]/route.ts` (DELETE)

**Interfaces:**
- `shift-types.ts`: `ShiftKind = "on_call"|"time_off"|"non_job"`, `ShiftRecord { id; technicianId; kind; title: string|null; startsAt: string; endsAt: string; removesCapacity: boolean }`, `shiftInputSchema` (kind, title? ≤80, startsAt/endsAt `z.iso.datetime()`, end > start, ≤ 31 days, `removesCapacity?`), `defaultRemovesCapacity(kind)` (on_call → false, else true), `blocksToScheduledJobs(rows) → ScheduledJob[]` (pure mapper: `{ id, referenceNumber: title ?? "Time off", status: "assigned", assignedTo: technicianId, arrivalWindowStart: startsAt, arrivalWindowEnd: endsAt }`).
- `shift-queries.ts`: `listShifts(orgId, technicianId, fromIso, toIso)`, `createShift(orgId, technicianId, input, createdBy) → ShiftRecord | { reason: "technician_not_found" }`, `deleteShift(orgId, technicianId, shiftId) → boolean`, `listCapacityBlocks(orgId, startIso, endIso) → ScheduledJob[]` (rows with `removesCapacity` overlapping the range), `technicianTimeOffOverlapping(orgId, technicianId, start: Date, end: Date) → ShiftRecord[]`.

- [ ] **Step 1: Failing tests** for `defaultRemovesCapacity`, `shiftInputSchema` (end before start rejected; 32-day rejected; on_call default false; time_off default true), `blocksToScheduledJobs` shape.
- [ ] **Step 2: Implement** (queries follow the Task-5a style; `listCapacityBlocks` = `select … from technicianShifts where withTenant(org, eq(removesCapacity,true), lt(startsAt, end), gt(endsAt, start))` mapped through `blocksToScheduledJobs`).
- [ ] **Step 3: Routes** — verify `[id]` is an active technician in the org (copy `queries.ts:616-630`); `readJsonBody`; audit `create_shift` / `delete_shift`, entity `technician_shifts`, details `{ technicianId, kind, removesCapacity }`. A multi-day absence is N single-day POSTs from the dialog; the API stays single-row.
- [ ] **Step 4: Probe** — POST a `time_off` for tomorrow, GET `?from=&to=` lists it, DELETE removes it.
- [ ] **Step 5: Gates + commit**

```bash
git add src/lib/admin/shift-types.ts src/lib/admin/shift-types.test.ts src/lib/admin/shift-queries.ts 'src/app/api/admin/technicians/[id]/shifts'
git commit -m "feat(scheduling): technician shifts (time off, on call, non-job events)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6b: Shifts subtracted in every availability path

**Files:**
- Modify: `src/lib/admin/scheduling-source.ts` (interface + `DbSchedulingSource`), `src/lib/integrations/housecall-pro/scheduling-source.ts:133` and `src/lib/integrations/fieldpulse/scheduling-source.ts:113` (both `implements SchedulingSource`; return `[]` — their tech ids are not `users.id`), `src/lib/admin/availability-queries.ts` (`readSchedulingFacts`), `src/lib/admin/availability-queries.test.ts` (both fakes gain `getCapacityBlocks: vi.fn().mockResolvedValue([])`), `src/lib/admin/availability.test.ts` (new case), `src/lib/admin/scheduling-queries.ts` (`checkScheduleConflict`, `placeAndAssignRequest`, `autoAssignBookedRequest`, `suggestTechnicians`)
- Modify: `src/lib/admin/queries.ts` `assignTechnician` / `reassignTechnician` (when the request already has an arrival window) and `scheduleRequest` (when `assignedTo` is set): call `technicianTimeOffOverlapping` and return a new `reason: "time_off"` variant that the `assign` route and the `[id]` PATCH route map to 409 `TIME_OFF` "That technician is off during this window." (read each function's result union and both routes first). Without this, `/assign` and the PATCH schedule path bypass time off.
- Modify: `src/lib/admin/scheduling-queries.test.ts:97` schema mock gains `technicianShifts`; mock `./shift-queries` (`technicianTimeOffOverlapping: vi.fn().mockResolvedValue([])`, `listCapacityBlocks: vi.fn().mockResolvedValue([])`); same for `queries.test.ts` if it mocks the schema.
- No change: `create-request-queries.ts` `technicianWindowClash` (delegates to `checkScheduleConflict`), `signals.ts` (only knows the day; the filter lives in the callers below).

- [ ] **Step 1: Interface** — add to `SchedulingSource`:
```ts
  /** Capacity-removing shifts (time off, non-job events) overlapping [startIso, endIso), as busy blocks. */
  getCapacityBlocks(startIso: string, endIso: string): Promise<readonly ScheduledJob[]>;
```
`DbSchedulingSource.getCapacityBlocks = (s, e) => listCapacityBlocks(this.organizationId, s, e)`; HCP and FieldPulse sources: `async getCapacityBlocks() { return []; }`.

- [ ] **Step 2: `readSchedulingFacts`** — `const [activeTechIds, availability, jobs, blocks] = await Promise.all([…, source.getCapacityBlocks(rangeStartIso, rangeEndIso)]); return { activeTechIds, availability, jobs: [...jobs, ...blocks] };`. Update the two fakes in `availability-queries.test.ts`.

- [ ] **Step 3: `availability.test.ts`** — add: a `ScheduledJob` block (from `blocksToScheduledJobs`) covering tech T's whole morning band removes T's morning capacity (same assertion style as the existing job-overlap cases).

- [ ] **Step 4: `checkScheduleConflict`** — after `rows`, also:
```ts
  const blocks = await db.select().from(technicianShifts)
    .where(withTenant(technicianShifts, organizationId, eq(technicianShifts.technicianId, technicianId), eq(technicianShifts.removesCapacity, true),
      lt(technicianShifts.startsAt, end), gt(technicianShifts.endsAt, start)))
    .orderBy(asc(technicianShifts.startsAt));
  return [...rows.map(toScheduledJob), ...blocksToScheduledJobs(blocks.map(toShiftRecord))];
```
(`toShiftRecord` is exported from `shift-queries.ts` in Task 6a: `{ id, technicianId, kind, title, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), removesCapacity }`.)
Callers surface `referenceNumber` in 409 copy, so a clash reads "Conflicts with Time off".

- [ ] **Step 5: `placeAndAssignRequest`** — time off is NOT overridable. Add a guard built whenever `targetTech` is set (independent of `options.override`):
```ts
  const noTimeOffGuard = targetTech
    ? sql`NOT EXISTS (SELECT 1 FROM technician_shifts s WHERE s.organization_id = ${organizationId} AND s.technician_id = ${targetTech}
          AND s.removes_capacity AND s.starts_at < ${arrivalWindow.end} AND s.ends_at > ${arrivalWindow.start})`
    : undefined;
```
and include it in the UPDATE's `and(...)`. Before the UPDATE, when `targetTech` is set, run `technicianTimeOffOverlapping(organizationId, targetTech, arrivalWindow.start, arrivalWindow.end)`; if non-empty return the existing conflict result shape (`{ ok: false, reason: "conflict", detail: { conflicts: blocksToScheduledJobs(blocks), outsideAvailability: false } }` — match the real shape at ~686) on BOTH the override and non-override paths. On a 0-row UPDATE, re-check the shift before falling through to the existing disambiguation, so PTO never surfaces as `request_not_found`.

- [ ] **Step 6: Auto-dispatch + suggestions** — in `autoAssignBookedRequest` (~1240) after the `techs` read, drop ids with a `removes_capacity` shift overlapping `[heldSlot.start, heldSlot.end)` before `firstFit` and `rankedTechnicianOrder` (one query: `listCapacityBlocks(org, heldSlot.start, heldSlot.end)` → set of `assignedTo`). In `suggestTechnicians` (~1196), drop techs whose capacity-removing shift covers the whole business day of `isoDay`. Add a pure helper `excludeTechniciansWithBlocks(techIds, blocks): string[]` in `shift-types.ts` with a test.

- [ ] **Step 7: Probe (Review Focus 4)**

```bash
TA=<techA>; D=<tomorrow YYYY-MM-DD>
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X POST http://localhost:3000/api/admin/technicians/$TA/shifts -d "{\"kind\":\"time_off\",\"title\":\"PTO\",\"startsAt\":\"${D}T13:00:00Z\",\"endsAt\":\"${D}T22:00:00Z\"}"; echo
curl -s -b "hvac_admin_session=$TOKEN" "http://localhost:3000/api/admin/requests/availability?start=$D&days=1"; echo      # morning/afternoon counts one lower than before the shift
# office booking assigned to A → 409 naming the time off
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X POST http://localhost:3000/api/admin/requests -d "{\"customerId\":\"$CID\",\"address\":\"1 Main St\",\"description\":\"test\",\"issueType\":\"maintenance\",\"urgency\":\"low\",\"schedule\":{\"isoDay\":\"$D\",\"window\":\"morning\",\"technicianId\":\"$TA\"}}"; echo
# window placement with override → still 409 (reschedule is the window-placement route: { date, arrivalWindow, technicianId?, override? })
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X POST http://localhost:3000/api/admin/requests/<rid with no window>/reschedule -d "{\"date\":\"$D\",\"arrivalWindow\":\"morning\",\"technicianId\":\"$TA\",\"override\":true}"; echo
# assign onto a request that already has a window inside the PTO → 409 TIME_OFF
curl -s -b "hvac_admin_session=$TOKEN" -H "$H" -X POST http://localhost:3000/api/admin/requests/<rid windowed in PTO>/assign -d "{\"technicianId\":\"$TA\"}"; echo
```
Auto-dispatch: run the existing autodispatch unit test suite (`npx vitest run src/lib/admin/scheduling-queries.test.ts src/lib/ai/dispatch`) and add a case in `scheduling-queries.test.ts` (it mocks db) showing a tech with a block is excluded from `firstFit` candidates. Delete the shift and any test request afterwards.

- [ ] **Step 8: Gates + commit**

```bash
git add src/lib/admin/scheduling-source.ts src/lib/integrations/housecall-pro/scheduling-source.ts src/lib/integrations/fieldpulse/scheduling-source.ts src/lib/admin/availability-queries.ts src/lib/admin/availability-queries.test.ts src/lib/admin/availability.test.ts src/lib/admin/scheduling-queries.ts src/lib/admin/scheduling-queries.test.ts src/lib/admin/queries.ts 'src/app/api/admin/requests/[id]/assign/route.ts' 'src/app/api/admin/requests/[id]/route.ts' src/lib/admin/shift-types.ts src/lib/admin/shift-types.test.ts
git commit -m "feat(scheduling): time off removes capacity in availability, conflicts, placement and auto-dispatch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6c: Time-off editor on the staff page

**Files:**
- Create: `src/components/admin/staff/time-off-dialog.tsx`; modify `src/components/admin/staff-table.tsx` (row action "Time off" on technician rows). Read `.claude/skills/page-staff/SKILL.md` first.

- [ ] **Step 1:** Dialog (spec "Time-off editor"): kind segmented control (Time off / On call / Non-job event), title, start date + time, end date + time, "Removes capacity" `Switch` defaulting to `defaultRemovesCapacity(kind)`, list of upcoming shifts (GET `?from=today&to=+90d`) with a remove button. Multi-day: when the end date is later than the start date, POST one row per day with the same clock times. Copy: "Couldn't save the time off. Please try again."
- [ ] **Step 2:** Screenshot `/admin/staff` with the dialog open (Playwright snippet; click the row action) at 1440 and 390. Look at them.
- [ ] **Step 3: Gates + commit**

```bash
git add src/components/admin/staff/time-off-dialog.tsx src/components/admin/staff-table.tsx
git commit -m "feat(staff): time off, on call and non-job events editor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Docs, skills, parity

- [ ] Update `.claude/skills/page-requests/SKILL.md` (visits API, new statuses, admin PATCH status values), `page-tech/SKILL.md` (taps), `page-staff/SKILL.md` (time off), `page-calendar/SKILL.md` (shifts subtracted; visits #2+ rendered in M2), `admin-pages/SKILL.md` (status constants live in `request-status.ts`; time off is never overridable). `node scripts/agent/verify-skills.mjs` → 0 missing.
- [ ] `replica/features.csv`: 117 ("En route / arrived / working statuses") → yes; 64 ("Multi-visit and multi-day jobs") → partial, note "visits via API + detail sheet; calendar rendering is M2"; 85 ("Technician shifts … with repeat") → partial, note "on-call / time-off / non-job rows; no repeat rule"; 86 ("Non-job events … remove capacity") → yes; 98 ("Multi-technician …") → partial, note "assignment rows + visits API; lane UI and guard in M2". Regenerate `replica/parity.md`. Append `replica/build-log.md` lines for S08, S13, S38.
- [ ] Commit `docs(replica): M0a in page skills, feature matrix and build log`.

---

## Self-review notes

- Spec coverage: enum + readers (T1–T2), appointments/assignments/trigger/backfill (T3), taps (T4), visits API + sheet (T5a–5b), shifts + five paths + UI (T6a–6c), docs (T7). Ownership unchanged, en-route texts out of scope, calendar rendering of visits #2+ is M2 (all per spec).
- Review Focus pins: 1–3 → T3 step 7; 4 → T6b step 7; 5 → T2 step 6 + T4 step 3.
- Cross-task names: `ScheduledJob` (existing, `types.ts:262`), `blocksToScheduledJobs`, `listCapacityBlocks`, `technicianTimeOffOverlapping`, `excludeTechniciansWithBlocks`, `AppointmentRecord`, the seven constants — each defined once and consumed by name.
