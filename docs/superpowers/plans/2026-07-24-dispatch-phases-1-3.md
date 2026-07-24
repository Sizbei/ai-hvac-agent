# Dispatch Phases 1-3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Turn native auto-dispatch into a self-improving loop by adding override telemetry, shadow-mode preview, an outcome rollup + weekly canary, a "why this tech?" decision panel, an exceptions rail, and three scoring-accuracy upgrades (chain-aware origin, recency-windowed signals, duration-fit down-rank) — all behind tests.

**Architecture:** One migration adds four columns to `dispatch_decisions` (override telemetry + shadow flag); the orchestrator `autoAssignBookedRequest` gains a shadow branch and threads a `isShadow` flag through `recordDispatchDecision`; a shared stamp helper records the human's final pick on the latest decision row from every human (re)assignment route; new pure rollup/decision-panel/exceptions queries feed the Operations page, a weekly digest cron, the request detail sheet, and the dispatch board; and the scorer (`signals.ts` + `score.ts`) gains chain origin, recency windows, and a duration-fit penalty.

**Tech Stack:** Next.js App Router (customized — check `node_modules/next/dist/docs/` if unsure of an API), Drizzle ORM over Neon Postgres via neon-http, React client components, Vitest (node env, no jsdom/RTL), TypeScript strict, ESLint.

## Execution sequencing

Tasks are **strictly sequential 1 → 10**. There is no parallelism: Task 1 (migration) unblocks everything; Tasks 2 & 3 both edit `scheduling-queries.ts` and its mock-queue test harness; Task 3 also edits `recordDispatchDecision` used by Task 4's rollup interpretation; Tasks 8 & 9 both edit `signals.ts` + `score.ts` **and both thread new scorer-input fields into `rankedTechnicianOrder` (`scheduling-queries.ts` :1139) plus its mocked `loadDispatchSignals` in `scheduling-queries.test.ts`** — they must not collide (Task 9's `bookedMinutes`/`dayMinutes`/`thisJobEstimate` additions sit alongside Task 8's `skillJobsCompletedRecent`). Run one implementer at a time, in order.

## Global Constraints

- Repo: `/Users/sizbei/Documents/GitHub/ai-hvac-agent`, Next.js App Router (customized — check `node_modules/next/dist/docs/` if unsure of an API). Drizzle ORM + Neon via **neon-http: `db.transaction()` THROWS at runtime** — use `db.batch()` or single guarded statements only.
- Migrations are **hand-authored**: a new file `drizzle/0041_dispatch_telemetry.sql` + an entry appended to `drizzle/meta/_journal.json` + a snapshot file `drizzle/meta/0041_snapshot.json` copied from `0040`'s snapshot with the new columns/FKs added. Migration must be **idempotent** (`ADD COLUMN IF NOT EXISTS`). Migrations auto-run on deploy (`vercel.json` buildCommand is `npm run db:migrate && next build`).
- ONE migration for all four new `dispatch_decisions` columns: `overridden_technician_id uuid references users(id)`, `overridden_by_user_id uuid references users(id)`, `overridden_at timestamptz`, `is_shadow boolean NOT NULL DEFAULT false`. Plus matching `schema.ts` additions on the `dispatchDecisions` table.
- Tests: **vitest, node environment, NO jsdom/RTL ever.** Query-layer tests use the repo's mocked-drizzle-chain pattern (a hoisted `chain` Proxy + `selectQueue`/`updateQueue`/`insertMock`/`batchMock`; `vi.mock('@/lib/db'...)`, `vi.mock('@/lib/db/tenant'...)`, `vi.mock('drizzle-orm'...)`, `vi.mock('@/lib/db/schema'...)`). Route tests mock `getAdminSession` + query functions and call handlers with `(request, { params: Promise.resolve({ id }) })`.
- Multi-tenancy: every query `withTenant`-scoped by `organizationId` (org always from `session.organizationId`, never the request body).
- All commits end with (exactly this trailer line, after a blank line):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- Full gate **per task**: `npx tsc --noEmit` (0 errors), `npx eslint <changed files>` (0 warnings/errors), `npx vitest run <the task's test files>` green.
- Reference facts (verified against the code):
  - `withTenant(table, organizationId, ...conditions: SQL[]): SQL` — from `@/lib/db/tenant`.
  - `logger` from `@/lib/logger` (pino; `.info/.warn/.error/.debug`).
  - `getAdminSession(): Promise<AdminSessionPayload | null>` from `@/lib/auth/session`; `AdminSessionPayload = { userId, organizationId, email, name, role }`.
  - `isUuid(value): value is string` from `@/lib/validation/uuid` (also exports `UUID_REGEX`).
  - `successResponse<T>(data, status=200)` and `errorResponse(message, code, status=400, details?)` from `@/lib/api-response`.
  - `verifyCronAuth(authHeader: string | null): boolean` from `@/lib/cron-auth`.
  - `sendSms({ to, body, from? }): Promise<SmsResult>` from `@/lib/communication/twilio-adapter` — **THROWS** when `TWILIO_PHONE_NUMBER` is unset.
  - `dispatchDecisions` columns today: `id, organizationId, serviceRequestId, outcome, chosenTechnicianId, topScore, confidenceGap, candidates(jsonb), createdAt` (schema.ts:2411).

---

### Task 1: Migration 0041 + schema.ts columns

Adds the four telemetry columns to `dispatch_decisions`. Nothing reads them yet; this unblocks Tasks 2–4. No test file (schema/migration only); the gate is `tsc` + the schema-consuming test suites staying green.

**Files:**
- Create: `drizzle/0041_dispatch_telemetry.sql`
- Create: `drizzle/meta/0041_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/db/schema.ts` (dispatchDecisions table, ~line 2449 before `createdAt`)

**Interfaces:**
- Consumes: nothing.
- Produces: `dispatchDecisions.overriddenTechnicianId: uuid|null`, `.overriddenByUserId: uuid|null`, `.overriddenAt: Date|null`, `.isShadow: boolean` (drizzle column refs for later tasks). Also extends the `candidates` JSONB `$type` with an optional `skillMatched?: boolean` (a `$type`-only change, no DDL) that Task 3 stores and Task 6 reads.

- [ ] **Step 1: Write the migration SQL.** Create `drizzle/0041_dispatch_telemetry.sql` (idempotent — `ADD COLUMN IF NOT EXISTS`, and FK adds guarded so re-run never errors):
```sql
ALTER TABLE "dispatch_decisions" ADD COLUMN IF NOT EXISTS "overridden_technician_id" uuid;--> statement-breakpoint
ALTER TABLE "dispatch_decisions" ADD COLUMN IF NOT EXISTS "overridden_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "dispatch_decisions" ADD COLUMN IF NOT EXISTS "overridden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dispatch_decisions" ADD COLUMN IF NOT EXISTS "is_shadow" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dispatch_decisions" ADD CONSTRAINT "dispatch_decisions_overridden_technician_id_users_id_fk" FOREIGN KEY ("overridden_technician_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dispatch_decisions" ADD CONSTRAINT "dispatch_decisions_overridden_by_user_id_users_id_fk" FOREIGN KEY ("overridden_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
```

- [ ] **Step 2: Append the journal entry.** In `drizzle/meta/_journal.json`, append to the `entries` array (after the `0040_faulty_manta` object, idx 40). Add a comma after the `0040` closing brace, then:
```json
    {
      "idx": 41,
      "version": "7",
      "when": 1784500000000,
      "tag": "0041_dispatch_telemetry",
      "breakpoints": true
    }
```

- [ ] **Step 3: Create the snapshot.** Copy `drizzle/meta/0040_snapshot.json` to `drizzle/meta/0041_snapshot.json`, then edit the copy exactly as follows:
  1. Change the top-level `"id"` to a new random UUID (any distinct UUIDv4, e.g. `"a1a2a3a4-b1b2-c1c2-d1d2-e1e2e3e4e5e6"`).
  2. Change the top-level `"prevId"` to the OLD file's `"id"` value: `"d4306722-6f32-4d29-95f8-c4e2eb7e7b31"`.
  3. In `tables["public.dispatch_decisions"].columns`, add these four entries (place them after `"candidates"` and before `"created_at"`):
```json
    "overridden_technician_id": {
      "name": "overridden_technician_id",
      "type": "uuid",
      "primaryKey": false,
      "notNull": false
    },
    "overridden_by_user_id": {
      "name": "overridden_by_user_id",
      "type": "uuid",
      "primaryKey": false,
      "notNull": false
    },
    "overridden_at": {
      "name": "overridden_at",
      "type": "timestamp with time zone",
      "primaryKey": false,
      "notNull": false
    },
    "is_shadow": {
      "name": "is_shadow",
      "type": "boolean",
      "primaryKey": false,
      "notNull": true,
      "default": false
    },
```
  4. In `tables["public.dispatch_decisions"].foreignKeys`, add these two entries (alongside the existing three):
```json
    "dispatch_decisions_overridden_technician_id_users_id_fk": {
      "name": "dispatch_decisions_overridden_technician_id_users_id_fk",
      "tableFrom": "dispatch_decisions",
      "tableTo": "users",
      "columnsFrom": ["overridden_technician_id"],
      "columnsTo": ["id"],
      "onDelete": "set null",
      "onUpdate": "no action"
    },
    "dispatch_decisions_overridden_by_user_id_users_id_fk": {
      "name": "dispatch_decisions_overridden_by_user_id_users_id_fk",
      "tableFrom": "dispatch_decisions",
      "tableTo": "users",
      "columnsFrom": ["overridden_by_user_id"],
      "columnsTo": ["id"],
      "onDelete": "set null",
      "onUpdate": "no action"
    },
```

- [ ] **Step 4: Add the schema columns.** In `src/lib/db/schema.ts`, inside `dispatchDecisions` (after the `candidates` field, before `createdAt` at ~line 2449):
```ts
    // ── Override telemetry (0041): the human's final pick recorded against the
    // autopilot decision. Set by stampDispatchOverride on any HUMAN (re)assignment
    // when chosen_technician_id IS DISTINCT FROM the pick. Last-write-wins.
    overriddenTechnicianId: uuid("overridden_technician_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    overriddenByUserId: uuid("overridden_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    overriddenAt: timestamp("overridden_at", { withTimezone: true }),
    // Shadow mode (0041): true for a would-be decision recorded for an autopilot-
    // OFF org (preview + tuning dataset); never touches service_requests. Operational
    // reads filter is_shadow=false; tuning/health reads split both.
    isShadow: boolean("is_shadow").notNull().default(false),
```
  Also extend the `candidates` JSONB `$type` (~line 2437) to carry the per-candidate `skillMatched` flag Task 3 will store and Task 6 will read back (optional so legacy rows without it still typecheck). Change the `.$type<Array<{ ... }>>()` to add `skillMatched?: boolean;`:
```ts
    candidates: jsonb("candidates")
      .$type<
        Array<{
          technicianId: string;
          score: number;
          reasons: string[];
          travelKm?: number | null;
          travelMinutes?: number | null;
          // Stored by recordDispatchDecision (Task 3); read by the decision panel
          // (Task 6). Optional: rows recorded before this field omit it (unknown).
          skillMatched?: boolean;
        }>
      >()
      .notNull()
      .default(sql`'[]'::jsonb`),
```
  (This is a `$type`-only change — no column DDL, so migration 0041 is unaffected.)

- [ ] **Step 5: Run the gate.**
```bash
npx tsc --noEmit
npx eslint src/lib/db/schema.ts
npx vitest run src/lib/admin/scheduling-queries.test.ts src/lib/ai/dispatch/signals.test.ts
```
Expected: 0 tsc errors, 0 eslint problems, all suites green (the new columns are additive; existing tests untouched).

- [ ] **Step 6: Commit.**
```bash
git add drizzle/0041_dispatch_telemetry.sql drizzle/meta/0041_snapshot.json drizzle/meta/_journal.json src/lib/db/schema.ts
git commit -m "$(cat <<'EOF'
feat(dispatch): 0041 telemetry columns — override stamp + is_shadow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Override telemetry — shared stamp helper + actingUserId plumbing

New shared `stampDispatchOverride` records the human's final pick on the latest decision row; `actingUserId` is threaded into `assignTechnician`, `reassignTechnician` (both in `queries.ts`), and the human `placeAndAssignRequest` path, sourced from `session.userId` in the assign + reschedule routes. Best-effort: stamp failures are caught + logged, never fail the assignment. The background auto path passes `undefined` and never stamps.

**Files:**
- Create: `src/lib/admin/dispatch-override.ts`
- Create: `src/lib/admin/dispatch-override.test.ts`
- Modify: `src/lib/admin/queries.ts` (`assignTechnician` :471, `reassignTechnician` :591)
- Modify: `src/lib/admin/scheduling-queries.ts` (`placeAndAssignRequest` :577 — add optional `actingUserId` + call the stamp on a human reassignment)
- Modify: `src/app/api/admin/requests/[id]/assign/route.ts` (POST + PATCH call sites)
- Modify: `src/app/api/admin/requests/[id]/reschedule/route.ts` (placeAndAssignRequest call site)

**Interfaces:**
- Consumes: `dispatchDecisions` columns from Task 1 (including `isShadow` — the latest-row lookup filters `isShadow=false` so a human assignment following a shadow preview never stamps the shadow row); `withTenant`, `logger`, `db`.
- Produces: `stampDispatchOverride(organizationId: string, requestId: string, humanTechnicianId: string, actingUserId: string): Promise<void>` (best-effort, never throws). `assignTechnician(organizationId, requestId, technicianId, actingUserId?)`, `reassignTechnician(organizationId, requestId, technicianId, actingUserId?)`, `placeAndAssignRequest(..., options: { ...; actingUserId?: string })`.

- [ ] **Step 1: Write the failing test.** Create `src/lib/admin/dispatch-override.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { selectQueue, updateQueue, whereCalls, setCalls, chain, loggerError } =
  vi.hoisted(() => {
    const selectQueue: unknown[][] = [];
    const updateQueue: unknown[][] = [];
    const whereCalls: unknown[][] = [];
    const setCalls: unknown[][] = [];
    const loggerError = vi.fn();
    const chain = (resolved: unknown): unknown => {
      const p: unknown = new Proxy(() => {}, {
        get(_t, prop) {
          if (prop === "then")
            return (resolve: (v: unknown) => void) => resolve(resolved);
          if (prop === "where")
            return (...args: unknown[]) => {
              whereCalls.push(args);
              return p;
            };
          if (prop === "set")
            return (...args: unknown[]) => {
              setCalls.push(args);
              return p;
            };
          return () => p;
        },
        apply: () => p,
      });
      return p;
    };
    return { selectQueue, updateQueue, whereCalls, setCalls, chain, loggerError };
  });

vi.mock("@/lib/db", () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    update: () => chain(updateQueue.shift() ?? []),
  },
}));
vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_t: unknown, orgId: string, ...conditions: unknown[]) => ({
    __tenant: orgId,
    conditions,
  }),
}));
vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => ["eq", ...a],
  and: (...a: unknown[]) => ["and", ...a],
  desc: (c: unknown) => c,
  sql: (_s: TemplateStringsArray, ..._v: unknown[]) => ["sql"],
}));
vi.mock("@/lib/db/schema", () => ({
  dispatchDecisions: {
    id: "dd.id",
    organizationId: "dd.org",
    serviceRequestId: "dd.req",
    chosenTechnicianId: "dd.chosen",
    overriddenTechnicianId: "dd.overTech",
    overriddenByUserId: "dd.overBy",
    overriddenAt: "dd.overAt",
    isShadow: "dd.shadow",
    createdAt: "dd.created",
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: loggerError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { stampDispatchOverride } from "./dispatch-override";

const ORG = "00000000-0000-0000-0000-000000000001";
const REQ = "00000000-0000-0000-0000-0000000000b1";
const HUMAN_TECH = "00000000-0000-0000-0000-0000000000a1";
const ACTOR = "00000000-0000-0000-0000-0000000000f1";

beforeEach(() => {
  selectQueue.length = 0;
  updateQueue.length = 0;
  whereCalls.length = 0;
  setCalls.length = 0;
  loggerError.mockClear();
});

describe("stampDispatchOverride", () => {
  it("stamps the latest decision row when the human pick differs", async () => {
    selectQueue.push([{ id: "dec-1", chosenTechnicianId: "someone-else" }]);
    updateQueue.push([{ id: "dec-1" }]);
    await stampDispatchOverride(ORG, REQ, HUMAN_TECH, ACTOR);
    // One read (latest row) + one write (the stamp).
    expect(whereCalls.length).toBe(2);
    // The read is tenant-scoped and filters on the request.
    expect((whereCalls[0][0] as { __tenant: string }).__tenant).toBe(ORG);
    // The write is tenant-scoped too.
    expect((whereCalls[1][0] as { __tenant: string }).__tenant).toBe(ORG);
    // The UPDATE's set-values carry the three override fields.
    expect(setCalls.length).toBe(1);
    expect(setCalls[0][0]).toEqual(
      expect.objectContaining({
        overriddenTechnicianId: HUMAN_TECH,
        overriddenByUserId: ACTOR,
        overriddenAt: expect.any(Date),
      }),
    );
  });

  it("does NOT stamp when the latest decision row is a shadow row", async () => {
    // The real query filters is_shadow=false, so a request whose only decision is
    // a shadow row returns NO latest row → the stamp must be a no-op. The read's
    // where must carry the isShadow=false filter so the shadow row is excluded.
    selectQueue.push([]); // shadow row filtered out by the query → no latest row
    await stampDispatchOverride(ORG, REQ, HUMAN_TECH, ACTOR);
    expect(whereCalls.length).toBe(1); // only the read ran
    expect(updateQueue.length).toBe(0); // no update attempted
    expect(setCalls.length).toBe(0);
    // The read filters out shadow rows (the isShadow=false condition is present).
    const readConds = (whereCalls[0][0] as { conditions: unknown[] }).conditions;
    expect(JSON.stringify(readConds)).toContain("dd.shadow");
  });

  it("does NOT update when the human pick equals what autopilot chose", async () => {
    // Latest row's chosen tech IS the human's pick → the decision was not
    // overridden, so the helper short-circuits in JS and issues NO update call.
    selectQueue.push([{ id: "dec-1", chosenTechnicianId: HUMAN_TECH }]);
    await stampDispatchOverride(ORG, REQ, HUMAN_TECH, ACTOR);
    expect(whereCalls.length).toBe(1); // only the read ran
    expect(updateQueue.length).toBe(0); // no update chain was consumed
    expect(setCalls.length).toBe(0);
  });

  it("does nothing when there is no decision row", async () => {
    selectQueue.push([]); // no latest row
    await stampDispatchOverride(ORG, REQ, HUMAN_TECH, ACTOR);
    // Only the read ran; no update attempted.
    expect(whereCalls.length).toBe(1);
    expect(updateQueue.length).toBe(0);
  });

  it("swallows a write failure (best-effort, never throws)", async () => {
    selectQueue.push([{ id: "dec-1", chosenTechnicianId: "someone-else" }]);
    // No update queued → chain resolves []; but force the update to throw.
    const throwingChain = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then")
          return () => {
            throw new Error("db down");
          };
        return () => throwingChain;
      },
      apply: () => throwingChain,
    });
    const db = (await import("@/lib/db")).db as { update: () => unknown };
    const spy = vi.spyOn(db, "update").mockReturnValueOnce(throwingChain);
    await expect(
      stampDispatchOverride(ORG, REQ, HUMAN_TECH, ACTOR),
    ).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to see it fail.**
```bash
npx vitest run src/lib/admin/dispatch-override.test.ts
```
Expected failure: `Failed to resolve import "./dispatch-override"` / `stampDispatchOverride is not a function` (module does not exist yet).

- [ ] **Step 3: Implement the helper.** Create `src/lib/admin/dispatch-override.ts`:
```ts
/**
 * Override telemetry — record the human dispatcher's final pick against the
 * autopilot's decision row, the ground-truth label every tuning effort needs.
 *
 * Called from every HUMAN (re)assignment path (assignTechnician,
 * reassignTechnician, and the human placeAndAssignRequest path). Looks up the
 * request's LATEST REAL decision row (is_shadow=false, created_at DESC LIMIT 1) —
 * a shadow preview row is never stamped, else the human pick would poison the
 * tuning labels. When a real row exists and its chosen tech differs from the
 * human's pick, stamps the three override fields. Queued rows have
 * chosen_technician_id = NULL, so any human pick counts as a resolution label —
 * intentional. Last-write-wins: a later human reassignment overwrites the stamp.
 *
 * BEST-EFFORT: a second, non-batched write. Losing a label on a crash is
 * acceptable for telemetry — money-grade atomicity is deliberately NOT required.
 * Never throws; a failure is logged and swallowed so it can't fail the
 * assignment. The background auto-dispatch path passes no actor and never calls
 * this. Tenant-scoped on read and write.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dispatchDecisions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { logger } from "@/lib/logger";

export async function stampDispatchOverride(
  organizationId: string,
  requestId: string,
  humanTechnicianId: string,
  actingUserId: string,
): Promise<void> {
  try {
    const [latest] = await db
      .select({
        id: dispatchDecisions.id,
        chosenTechnicianId: dispatchDecisions.chosenTechnicianId,
      })
      .from(dispatchDecisions)
      .where(
        withTenant(
          dispatchDecisions,
          organizationId,
          and(
            eq(dispatchDecisions.serviceRequestId, requestId),
            // Never stamp a shadow (autopilot-off preview) row: a human
            // assignment following a shadow decision must land on a REAL decision
            // row (or nothing), else it would poison the tuning labels.
            eq(dispatchDecisions.isShadow, false),
          )!,
        ),
      )
      .orderBy(desc(dispatchDecisions.createdAt))
      .limit(1);
    if (!latest) return;
    // No-op when the human picked exactly what autopilot chose — the decision was
    // NOT overridden, so there is nothing to label (and we skip the write).
    if (latest.chosenTechnicianId === humanTechnicianId) return;

    // Stamp only when the human's pick differs from what autopilot chose. A
    // queued row's chosen is NULL, so IS DISTINCT FROM fires for any human pick.
    // The SQL guard is defense-in-depth against a race with a concurrent stamp.
    await db
      .update(dispatchDecisions)
      .set({
        overriddenTechnicianId: humanTechnicianId,
        overriddenByUserId: actingUserId,
        overriddenAt: new Date(),
      })
      .where(
        withTenant(
          dispatchDecisions,
          organizationId,
          and(
            eq(dispatchDecisions.id, latest.id),
            sql`${dispatchDecisions.chosenTechnicianId} IS DISTINCT FROM ${humanTechnicianId}`,
          )!,
        ),
      );
  } catch (error) {
    logger.error(
      { error, serviceRequestId: requestId },
      "Failed to stamp dispatch override (non-fatal telemetry)",
    );
  }
}
```

- [ ] **Step 4: Thread `actingUserId` into the query functions.** In `src/lib/admin/queries.ts`:
  1. Add the import near the top (after the `recordStatusEvent` import ~line 42): `import { stampDispatchOverride } from "./dispatch-override";`
  2. `assignTechnician` (:471) — add a 4th param and call the stamp after the successful `recordStatusEvent`. Change the signature:
```ts
export async function assignTechnician(
  organizationId: string,
  requestId: string,
  technicianId: string,
  actingUserId?: string,
): Promise<AssignTechnicianResult> {
```
  Then immediately after the `await recordStatusEvent({ ... actorType: "human" });` block (before `return { ok: true, ... }`), add:
```ts
  // Telemetry: this is a HUMAN assignment — label the autopilot decision row
  // with the human's final pick (best-effort; never fails the assignment).
  if (actingUserId) {
    await stampDispatchOverride(
      organizationId,
      requestId,
      technicianId,
      actingUserId,
    );
  }
```
  3. `reassignTechnician` (:591) — add the 4th param `actingUserId?: string` to the signature the same way, and immediately before the final `return { ok: true, request: { ... } };` add the same stamp block (verbatim, same four lines as above).

- [ ] **Step 5: Thread `actingUserId` into `placeAndAssignRequest`.** In `src/lib/admin/scheduling-queries.ts`:
  1. Add the import near the top (after the `notifyCustomerOfAssignment` import ~line 54): `import { stampDispatchOverride } from "./dispatch-override";`
  2. Add `readonly actingUserId?: string;` to the `options` object type of `placeAndAssignRequest` (:581, alongside `assignmentActor`):
```ts
    /**
     * The human dispatcher initiating this placement, for override telemetry.
     * Threaded from session.userId by the reschedule route. Omitted by the
     * background auto-dispatch path (which never stamps).
     */
    readonly actingUserId?: string;
```
  3. After the `isFirstAssignment` / `recordStatusEvent` block and before the `overriddenConflicts` recompute (~after line 788), add the stamp — on ANY human placement (first-time placements are labels too, not only reassignments):
```ts
  // Telemetry: a HUMAN drag/placement that (re)assigned the tech — label the
  // autopilot decision row. Guarded ONLY on actingUserId (present iff a human
  // initiated this): a first-time human placement is as much a label as a
  // reassignment, so we do NOT also require `reassigning`. The background
  // auto-dispatch path passes no actingUserId and never stamps. Best-effort;
  // never fails the placement.
  if (options.actingUserId) {
    await stampDispatchOverride(
      organizationId,
      requestId,
      options.technicianId!,
      options.actingUserId,
    );
  }
```

- [ ] **Step 6: Thread `session.userId` at the route call sites.**
  1. `src/app/api/admin/requests/[id]/assign/route.ts` — POST call (:55): add `session.userId` as the 4th arg:
```ts
    const result = await assignTechnician(
      session.organizationId,
      id,
      technicianId,
      session.userId,
    );
```
  and PATCH call (:138):
```ts
    const result = await reassignTechnician(
      session.organizationId,
      id,
      technicianId,
      session.userId,
    );
```
  2. `src/app/api/admin/requests/[id]/reschedule/route.ts` — the `placeAndAssignRequest` call (:93) options object: add `actingUserId: session.userId,` alongside `override`:
```ts
    const result = await placeAndAssignRequest(
      session.organizationId,
      id,
      window,
      {
        isoDay: parsed.data.date,
        window: arrivalWindow,
        technicianId: parsed.data.technicianId,
        override: parsed.data.override,
        actingUserId: session.userId,
      },
    );
```

- [ ] **Step 7: Run to pass.**
```bash
npx vitest run src/lib/admin/dispatch-override.test.ts src/lib/admin/scheduling-queries.test.ts
```
Expected: all green. (The existing `scheduling-queries.test.ts` still passes — `stampDispatchOverride` is only called when `actingUserId` is set, which none of those tests pass; when it IS called with a mocked db that returns `[]`, it no-ops. If a test's queue is exhausted, the chain returns `[]` and the stamp finds no latest row → harmless.)

- [ ] **Step 8: Run the full gate.**
```bash
npx tsc --noEmit
npx eslint src/lib/admin/dispatch-override.ts src/lib/admin/dispatch-override.test.ts src/lib/admin/queries.ts src/lib/admin/scheduling-queries.ts "src/app/api/admin/requests/[id]/assign/route.ts" "src/app/api/admin/requests/[id]/reschedule/route.ts"
```

- [ ] **Step 9: Commit.**
```bash
git add src/lib/admin/dispatch-override.ts src/lib/admin/dispatch-override.test.ts src/lib/admin/queries.ts src/lib/admin/scheduling-queries.ts "src/app/api/admin/requests/[id]/assign/route.ts" "src/app/api/admin/requests/[id]/reschedule/route.ts"
git commit -m "$(cat <<'EOF'
feat(dispatch): override telemetry — stamp human pick on decision row

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Shadow mode — record the would-be decision for autopilot-off orgs

`recordDispatchDecision` gains an `isShadow` param (default false). In `autoAssignBookedRequest`, the autopilot-OFF branch (after the external-scheduler early return, skipping the booking-quality gate) runs `rankedTechnicianOrder` + `classifyDispatch` when the job is classifiable and records the would-be outcome with `is_shadow=true` — WITHOUT `stampDispatchOutcome` and WITHOUT any assignment write; the routing/travel call is skipped (haversine only) for shadow. Then first-fit continues unchanged. Unclassifiable → record nothing.

**Files:**
- Modify: `src/lib/admin/scheduling-queries.ts` (`recordDispatchDecision` :980, `rankedTechnicianOrder` :1111, `loadDispatchSignals` call, `autoAssignBookedRequest` :1219)
- Modify: `src/lib/ai/dispatch/signals.ts` (`loadDispatchSignals` gains a `skipRouting` flag that bypasses `durationMatrix`)
- Modify: `src/lib/admin/scheduling-queries.test.ts` (add shadow-mode cases)
- Modify: `src/lib/ai/dispatch/signals.test.ts` (assert `skipRouting` bypasses routing)

**Interfaces:**
- Consumes: `dispatchDecisions.isShadow` (Task 1); `rankTechnicians`, `classifyDispatch` (score.ts); `loadDispatchSignals` (signals.ts).
- Produces: `recordDispatchDecision(organizationId, requestId, outcome, chosenTechnicianId, ranked, isShadow?)` — its `candidates` JSONB now also stores `skillMatched: boolean` per candidate (from `RankedTech.skillMatched`), consumed by Task 6's decision panel; `loadDispatchSignals(organizationId, technicianIds, job, isoDay, requestId?, opts?: { skipRouting?: boolean })`; `rankedTechnicianOrder(organizationId, requestId, technicianIds, isoDay, fallbackUnclassified?, skipRouting?)`.

- [ ] **Step 1: Write the failing tests.**
  (a) In `src/lib/ai/dispatch/signals.test.ts`, add inside the `travel term` describe block:
```ts
    it("skips the routing call when skipRouting is set (haversine only)", async () => {
      routingEnabled.mockReturnValue(true);
      durationMatrix.mockResolvedValue([12]);
      getLatestTechnicianLocations.mockResolvedValue(
        new Map([["t1", { latitude: 36.0, longitude: -82.0 }]]),
      );
      selectQueue.push(
        [], [], [], [], [],
        [{ lat: 36.33, lon: -82.38 }], // job coords
        [{ id: "t1", lat: 36.0, lon: -82.0 }], // home base
      );
      const m = await loadDispatchSignals(
        "org",
        ["t1"],
        { jobType: "no_cool", systemType: null },
        "2026-06-24",
        "req-1",
        { skipRouting: true },
      );
      // Haversine km present, but routing was NOT invoked (shadow saves ORS quota).
      expect(m.get("t1")!.travelKm).not.toBeNull();
      expect(m.get("t1")!.travelMinutes).toBeNull();
      expect(durationMatrix).not.toHaveBeenCalled();
    });
```
  (b) In `src/lib/admin/scheduling-queries.test.ts`, first make the `db.insert` mock capture the `.values()` payload so the shadow test can assert `is_shadow=true`. Change the hoisted `db` mock's `insert` (:57) from:
```ts
    insert: () => {
      insertMock();
      return chain([]);
    },
```
  to capture the values object (keeps the existing call-count semantics — one call per insert, since `recordDispatchDecision` always chains `.values()`):
```ts
    insert: () => ({
      values: (v: unknown) => {
        insertMock(v);
        return chain([]);
      },
    }),
```
  (Existing `expect(insertMock).toHaveBeenCalled()` / `toHaveBeenCalledTimes(1)` / `not.toHaveBeenCalled()` assertions still hold; the mock is now additionally called WITH the values payload.)

  Then add these cases inside `describe("autoAssignBookedRequest (scored vs first-fit)", ...)`:
```ts
  it("shadow: autopilot OFF but classifiable → records is_shadow decision, still first-fits", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]); // active techs
    queueAutoAssignLeadIn(false); // duration/external/flag=OFF (quality gate skipped)
    selectQueue.push([CLASSIFIED]); // rankedTechnicianOrder → classification (shadow)
    rankedState.order = [T2, T1]; // shadow ranker prefers T2
    queueSuccessfulPlacement(T1); // first-fit still places DB-order T1

    const result = await autoAssignBookedRequest(ORG, REQ, HELD);
    // First-fit outcome is unchanged (T1 wins), and a SHADOW decision was recorded.
    expect(result).toEqual({ assigned: true, technicianId: T1 });
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ isShadow: true }),
    );
  });

  it("shadow: autopilot OFF and UNCLASSIFIABLE → records nothing, first-fits", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]); // active techs
    queueAutoAssignLeadIn(false);
    selectQueue.push([{ jobType: null, systemType: null, urgency: "standard" }]); // unclassified
    queueSuccessfulPlacement(T1);

    const result = await autoAssignBookedRequest(ORG, REQ, HELD);
    expect(result).toEqual({ assigned: true, technicianId: T1 });
    expect(insertMock).not.toHaveBeenCalled(); // nothing recorded
  });
```

- [ ] **Step 2: Run to see them fail.**
```bash
npx vitest run src/lib/ai/dispatch/signals.test.ts src/lib/admin/scheduling-queries.test.ts
```
Expected failures: signals test — `durationMatrix` still called (no `skipRouting` support yet); scheduling tests — the disabled branch reads the classification it doesn't expect (queue drift → wrong tech) and `insertMock` not called (no shadow recording yet).

- [ ] **Step 3a: Add `skipRouting` to `loadDispatchSignals`.** In `src/lib/ai/dispatch/signals.ts`:
  1. Change the `loadDispatchSignals` signature (:94) to add an `opts` param:
```ts
export async function loadDispatchSignals(
  organizationId: string,
  technicianIds: readonly string[],
  job: DispatchJobAttrs,
  isoDay: string,
  requestId?: string,
  opts: { readonly skipRouting?: boolean } = {},
): Promise<Map<string, TechSignalRow>> {
```
  2. Thread it into the travel loader call (:281):
```ts
  if (requestId) {
    const travelByTech = await loadTravelSignals(
      organizationId,
      requestId,
      technicianIds,
      opts.skipRouting ?? false,
    );
```
  3. Add the param to `loadTravelSignals` (:304) and gate the routing block on it:
```ts
async function loadTravelSignals(
  organizationId: string,
  requestId: string,
  technicianIds: readonly string[],
  skipRouting: boolean,
): Promise<Map<string, { km: number | null; minutes: number | null }>> {
```
  and change the routing guard (:328) from `if (routingEnabled()) {` to:
```ts
  // Shadow scoring passes skipRouting → haversine only (a preview must not spend
  // ORS quota; the km fallback already exists).
  if (!skipRouting && routingEnabled()) {
```

- [ ] **Step 3b: Add `isShadow` to `recordDispatchDecision` + `skipRouting` to `rankedTechnicianOrder`; add the shadow branch.** In `src/lib/admin/scheduling-queries.ts`:
  1. `recordDispatchDecision` (:980) — add the param and pass it to the insert:
```ts
async function recordDispatchDecision(
  organizationId: string,
  requestId: string,
  outcome: DispatchOutcome,
  chosenTechnicianId: string | null,
  ranked: readonly RankedTech[],
  isShadow = false,
): Promise<void> {
```
  and inside `db.insert(dispatchDecisions).values({ ... })` add `isShadow,` alongside `outcome`. Also STORE `skillMatched` per candidate — the `RankedTech` objects already carry a `skillMatched: boolean` (verified in `src/lib/ai/dispatch/score.ts`), and the decision panel (Task 6) reads it back instead of re-deriving it from reason text. Change the existing `candidates: ranked.map((r) => ({ ... }))` (:996) to add `skillMatched: r.skillMatched,`:
```ts
      candidates: ranked.map((r) => ({
        technicianId: r.technicianId,
        score: r.score,
        reasons: [...r.reasons],
        // Both travel signals, for the routing-vs-haversine A/B + weight tuning.
        travelKm: r.travelKm,
        travelMinutes: r.travelMinutes,
        // Stored (not parsed later) so the decision panel reports it faithfully.
        skillMatched: r.skillMatched,
      })),
```
  2. `rankedTechnicianOrder` (:1111) — add a `skipRouting` param and thread it to `loadDispatchSignals`:
```ts
async function rankedTechnicianOrder(
  organizationId: string,
  requestId: string,
  technicianIds: readonly string[],
  isoDay: string,
  fallbackUnclassified = false,
  skipRouting = false,
): Promise<{
  readonly ranked: RankedTech[] | null;
  readonly job: DispatchSignals["job"] | null;
}> {
```
  and change the `loadDispatchSignals(...)` call (:1132) to pass the opts:
```ts
  const signalsByTech = await loadDispatchSignals(
    organizationId,
    technicianIds,
    job,
    isoDay,
    requestId,
    { skipRouting },
  );
```
  3. In `autoAssignBookedRequest` (:1219), add the shadow branch. It must run AFTER the `isExternallyScheduled` early return (:1248) and AFTER `const enabled = await isAutoDispatchEnabled(...)` (:1255), but BEFORE the booking-quality gate block (which is inside `if (enabled)`). Insert this block right after the `const enabled = ...` line:
```ts
  // Shadow mode: an autopilot-OFF org still scores + records the would-be
  // decision (preview + tuning dataset) — never touching service_requests (no
  // outcome stamp, no assignment) and skipping the booking-quality gate (it
  // writes to service_requests). Haversine-only (skipRouting) so a preview never
  // spends ORS quota. Unclassifiable jobs record nothing. Then first-fit runs
  // below, unchanged.
  if (!enabled) {
    const shadow = await rankedTechnicianOrder(
      organizationId,
      requestId,
      firstFit,
      heldSlot.isoDay,
      false, // auto-assign semantics: unclassifiable → null (record nothing)
      true, // skipRouting: haversine only for the preview
    );
    if (shadow.ranked) {
      const decision = classifyDispatch(shadow.ranked, shadow.job?.urgency);
      await recordDispatchDecision(
        organizationId,
        requestId,
        decision.outcome,
        decision.outcome === "committed"
          ? (decision.technicianId ?? null)
          : null,
        shadow.ranked,
        true, // is_shadow
      );
    }
  }
```

- [ ] **Step 4: Run to pass.**
```bash
npx vitest run src/lib/ai/dispatch/signals.test.ts src/lib/admin/scheduling-queries.test.ts
```
Expected: all green. (In the shadow-classifiable test, the lead-in queue is `false`, then the shadow `rankedTechnicianOrder` consumes the pushed `[CLASSIFIED]` classification read; `loadDispatchSignals` is mocked so it doesn't touch the queue; `rankTechnicians` is the mocked ranker returning `rankedState.order`; `recordDispatchDecision` calls `insertMock`. Then `queueSuccessfulPlacement(T1)` drives the unchanged first-fit.)

- [ ] **Step 5: Run the full gate.**
```bash
npx tsc --noEmit
npx eslint src/lib/admin/scheduling-queries.ts src/lib/ai/dispatch/signals.ts src/lib/admin/scheduling-queries.test.ts src/lib/ai/dispatch/signals.test.ts
```

- [ ] **Step 6: Commit.**
```bash
git add src/lib/admin/scheduling-queries.ts src/lib/ai/dispatch/signals.ts src/lib/admin/scheduling-queries.test.ts src/lib/ai/dispatch/signals.test.ts
git commit -m "$(cat <<'EOF'
feat(dispatch): shadow mode — record would-be decision for autopilot-off orgs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Outcome rollup helper + Operations "Dispatch health" card

New pure helper `getDispatchOutcomeRollup(organizationId, days)` counts by outcome (real/shadow split) + override count + commit rate over real+shadow combined. The Operations metrics pipeline (type + query + hook + page card) gains a "Dispatch health" card showing the 7-day rollup.

**Files:**
- Create: `src/lib/admin/dispatch-rollup.ts`
- Create: `src/lib/admin/dispatch-rollup.test.ts`
- Modify: `src/lib/admin/operations-metrics-types.ts` (add `dispatchHealth` to `OperationsMetrics`)
- Modify: `src/lib/admin/operations-metrics-queries.ts` (call the rollup, add to the return)
- Modify: `src/hooks/use-operations-metrics.ts` (mirror the type)
- Modify: `src/app/admin/(dashboard)/operations/page.tsx` (render the card)

**Interfaces:**
- Consumes: `dispatchDecisions` (Task 1 columns).
- Produces: `getDispatchOutcomeRollup(organizationId: string, days: number): Promise<DispatchOutcomeRollup>` where
```ts
interface DispatchOutcomeRollup {
  readonly days: number;
  readonly real: { committed: number; queuedAmbiguous: number; queuedNoFit: number; queuedNeedsReview: number; total: number };
  readonly shadow: { committed: number; queuedAmbiguous: number; queuedNoFit: number; queuedNeedsReview: number; total: number };
  readonly overrides: number;
  readonly commitRate: number | null; // committed / total over real+shadow; null when total 0
}
```
  `OperationsMetrics.dispatchHealth: DispatchOutcomeRollup`.

- [ ] **Step 1: Write the failing test.** Create `src/lib/admin/dispatch-rollup.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { selectQueue, whereCalls, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const whereCalls: unknown[][] = [];
  const chain = (resolved: unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then")
          return (resolve: (v: unknown) => void) => resolve(resolved);
        if (prop === "where")
          return (...args: unknown[]) => {
            whereCalls.push(args);
            return p;
          };
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };
  return { selectQueue, whereCalls, chain };
});

vi.mock("@/lib/db", () => ({
  db: { select: () => chain(selectQueue.shift() ?? []) },
}));
vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_t: unknown, orgId: string, ...conditions: unknown[]) => ({
    __tenant: orgId,
    conditions,
  }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ["and", ...a],
  eq: (...a: unknown[]) => ["eq", ...a],
  gte: (...a: unknown[]) => ["gte", ...a],
  isNotNull: (c: unknown) => ["isNotNull", c],
  sql: Object.assign(
    (_s: TemplateStringsArray, ..._v: unknown[]) => ["sql"],
    { raw: (s: string) => ["sqlraw", s] },
  ),
}));
vi.mock("@/lib/db/schema", () => ({
  dispatchDecisions: {
    organizationId: "dd.org",
    outcome: "dd.outcome",
    isShadow: "dd.shadow",
    overriddenAt: "dd.overAt",
    createdAt: "dd.created",
  },
}));

import { getDispatchOutcomeRollup } from "./dispatch-rollup";

const ORG = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  selectQueue.length = 0;
  whereCalls.length = 0;
});

describe("getDispatchOutcomeRollup", () => {
  it("splits real vs shadow, counts overrides, computes commit rate over both", async () => {
    // One grouped query returns (outcome, is_shadow, n) rows + a separate overrides count.
    selectQueue.push([
      { outcome: "committed", isShadow: false, n: 8 },
      { outcome: "queued_ambiguous", isShadow: false, n: 2 },
      { outcome: "committed", isShadow: true, n: 5 },
      { outcome: "queued_no_fit", isShadow: true, n: 5 },
    ]);
    selectQueue.push([{ n: 3 }]); // overrides count
    const r = await getDispatchOutcomeRollup(ORG, 7);
    expect(r.days).toBe(7);
    expect(r.real.committed).toBe(8);
    expect(r.real.queuedAmbiguous).toBe(2);
    expect(r.real.total).toBe(10);
    expect(r.shadow.committed).toBe(5);
    expect(r.shadow.queuedNoFit).toBe(5);
    expect(r.shadow.total).toBe(10);
    expect(r.overrides).toBe(3);
    // commit rate = (8 + 5) committed / 20 total over real+shadow = 0.65
    expect(r.commitRate).toBeCloseTo(0.65, 5);
    expect((whereCalls[0][0] as { __tenant: string }).__tenant).toBe(ORG);
  });

  it("returns commitRate null when there are no decisions", async () => {
    selectQueue.push([]); // no grouped rows
    selectQueue.push([{ n: 0 }]); // overrides
    const r = await getDispatchOutcomeRollup(ORG, 7);
    expect(r.real.total).toBe(0);
    expect(r.shadow.total).toBe(0);
    expect(r.commitRate).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail.**
```bash
npx vitest run src/lib/admin/dispatch-rollup.test.ts
```
Expected failure: `Failed to resolve import "./dispatch-rollup"`.

- [ ] **Step 3: Implement the rollup helper.** Create `src/lib/admin/dispatch-rollup.ts`:
```ts
/**
 * Dispatch outcome rollup — counts by outcome over the last `days`, split into
 * REAL (is_shadow=false) and SHADOW (is_shadow=true), plus the override count and
 * a combined commit rate (committed / total over real+shadow together). Pure read;
 * tenant-scoped. Feeds the Operations "Dispatch health" card and the weekly canary.
 *
 * Commit rate spans real+shadow deliberately: shadow exercises the same
 * geocode/signal/weight pipeline, so a shadow collapse signals the same breakage,
 * and autopilot-off orgs would otherwise never have a signal to alert on.
 */
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dispatchDecisions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface DispatchOutcomeCounts {
  readonly committed: number;
  readonly queuedAmbiguous: number;
  readonly queuedNoFit: number;
  readonly queuedNeedsReview: number;
  readonly total: number;
}

export interface DispatchOutcomeRollup {
  readonly days: number;
  readonly real: DispatchOutcomeCounts;
  readonly shadow: DispatchOutcomeCounts;
  readonly overrides: number;
  /** committed / total over real+shadow combined; null when there are no decisions. */
  readonly commitRate: number | null;
}

const EMPTY: DispatchOutcomeCounts = {
  committed: 0,
  queuedAmbiguous: 0,
  queuedNoFit: 0,
  queuedNeedsReview: 0,
  total: 0,
};

function bump(
  counts: DispatchOutcomeCounts,
  outcome: string,
  n: number,
): DispatchOutcomeCounts {
  const total = counts.total + n;
  switch (outcome) {
    case "committed":
      return { ...counts, committed: counts.committed + n, total };
    case "queued_ambiguous":
      return { ...counts, queuedAmbiguous: counts.queuedAmbiguous + n, total };
    case "queued_no_fit":
      return { ...counts, queuedNoFit: counts.queuedNoFit + n, total };
    case "queued_needs_review":
      return {
        ...counts,
        queuedNeedsReview: counts.queuedNeedsReview + n,
        total,
      };
    default:
      return { ...counts, total };
  }
}

export async function getDispatchOutcomeRollup(
  organizationId: string,
  days: number,
): Promise<DispatchOutcomeRollup> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [grouped, overrideRows] = await Promise.all([
    db
      .select({
        outcome: dispatchDecisions.outcome,
        isShadow: dispatchDecisions.isShadow,
        n: sql<number>`count(*)`,
      })
      .from(dispatchDecisions)
      .where(
        withTenant(
          dispatchDecisions,
          organizationId,
          gte(dispatchDecisions.createdAt, since),
        ),
      )
      .groupBy(dispatchDecisions.outcome, dispatchDecisions.isShadow),
    db
      .select({ n: sql<number>`count(*)` })
      .from(dispatchDecisions)
      .where(
        withTenant(
          dispatchDecisions,
          organizationId,
          and(
            gte(dispatchDecisions.createdAt, since),
            isNotNull(dispatchDecisions.overriddenAt),
          )!,
        ),
      ),
  ]);

  let real = EMPTY;
  let shadow = EMPTY;
  for (const row of grouped) {
    const n = Number(row.n);
    if (row.isShadow) shadow = bump(shadow, row.outcome, n);
    else real = bump(real, row.outcome, n);
  }

  const combinedTotal = real.total + shadow.total;
  const combinedCommitted = real.committed + shadow.committed;
  const commitRate =
    combinedTotal > 0 ? combinedCommitted / combinedTotal : null;

  return {
    days,
    real,
    shadow,
    overrides: Number(overrideRows[0]?.n ?? 0),
    commitRate,
  };
}
```

- [ ] **Step 4: Run to pass the helper test.**
```bash
npx vitest run src/lib/admin/dispatch-rollup.test.ts
```
Expected: green.

- [ ] **Step 5: Wire the rollup into the operations pipeline.**
  1. `src/lib/admin/operations-metrics-types.ts` — add the import + field. At the top add:
```ts
import type { DispatchOutcomeRollup } from "./dispatch-rollup";
```
  and inside `OperationsMetrics`, after `firstResponseSystemSeconds` (:92), add:
```ts

  // 5. Dispatch health (7-day rollup: real vs shadow outcomes + commit rate).
  readonly dispatchHealth: DispatchOutcomeRollup;
```
  2. `src/lib/admin/operations-metrics-queries.ts` — import the helper (after the existing type import ~line 31):
```ts
import { getDispatchOutcomeRollup } from "./dispatch-rollup";
```
  Add the rollup INSIDE the existing `Promise.all([...])` (the array destructured at :123-133) so it runs concurrently with the other aggregates — no serial extra roundtrip on Operations load. It takes no window params (always 7-day). Add `dispatchHealth` as a new destructured element and append its call as the last entry of the `Promise.all` array (after the imported-jobs query at :316-327, before the closing `]);` at :328):
```ts
  const [
    inProgressRows,
    assignedRows,
    paidRows,
    onSiteRow,
    agingRow,
    syncedAgingRow,
    jobsCurrentRow,
    jobsPreviousRow,
    importedJobsCurrentRow,
    dispatchHealth,
  ] = await Promise.all([
    // ...all existing queries unchanged...
    // (append as the FINAL array element, after the imported-jobs query:)
    getDispatchOutcomeRollup(organizationId, 7),
  ]);
```
  Concretely: add `dispatchHealth,` to the destructuring array (after `importedJobsCurrentRow,`) and add `getDispatchOutcomeRollup(organizationId, 7),` as the last element of the `Promise.all([...])` array (after the imported-jobs `db.select(...).where(...)` block's trailing comma). Then in the `return { ... }` object, add `dispatchHealth,` alongside `firstResponseSystemSeconds`.
  3. `src/hooks/use-operations-metrics.ts` — mirror the client type. After the `SyncedArAging` interface, add:
```ts
export interface DispatchOutcomeCounts {
  readonly committed: number;
  readonly queuedAmbiguous: number;
  readonly queuedNoFit: number;
  readonly queuedNeedsReview: number;
  readonly total: number;
}

export interface DispatchOutcomeRollup {
  readonly days: number;
  readonly real: DispatchOutcomeCounts;
  readonly shadow: DispatchOutcomeCounts;
  readonly overrides: number;
  readonly commitRate: number | null;
}
```
  and inside the hook's local `OperationsMetrics` interface, after `firstResponseSystemSeconds`, add `readonly dispatchHealth: DispatchOutcomeRollup;`.
  4. `src/app/admin/(dashboard)/operations/page.tsx` — render a "Dispatch health" card. Add `Zap` to the lucide import list at the top. Then in the second-row grid (`<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">`, :243), append a new `KpiCard` (the value is the 7-day commit rate; the foot summarizes counts):
```tsx
        <KpiCard
          label="Dispatch health"
          icon={Zap}
          value={
            metrics && metrics.dispatchHealth.commitRate !== null
              ? `${Math.round(metrics.dispatchHealth.commitRate * 100)}%`
              : null
          }
          delta={null}
          rangeDays={metrics?.dispatchHealth.days ?? 7}
          isLoading={isLoading}
          foot={
            metrics ? (
              <>
                Commit rate (7d, real + preview) ·{' '}
                <span className="font-semibold text-foreground">
                  {metrics.dispatchHealth.real.total}
                </span>{' '}
                real ·{' '}
                <span className="font-semibold text-foreground">
                  {metrics.dispatchHealth.shadow.total}
                </span>{' '}
                preview ·{' '}
                <span className="font-semibold text-foreground">
                  {metrics.dispatchHealth.overrides}
                </span>{' '}
                overrides
              </>
            ) : undefined
          }
        />
```

- [ ] **Step 6: Run the full gate.**
```bash
npx tsc --noEmit
npx eslint src/lib/admin/dispatch-rollup.ts src/lib/admin/dispatch-rollup.test.ts src/lib/admin/operations-metrics-types.ts src/lib/admin/operations-metrics-queries.ts src/hooks/use-operations-metrics.ts "src/app/admin/(dashboard)/operations/page.tsx"
npx vitest run src/lib/admin/dispatch-rollup.test.ts src/lib/admin/operations-metrics-queries.test.ts
```
Expected: green. If `operations-metrics-queries.test.ts` fails because the new `getDispatchOutcomeRollup` call has no queued mock rows, add its two mock results to that test's setup: push `[]` (grouped) and `[{ n: 0 }]` (overrides) at the end of each `getOperationsMetrics` test's select queue, OR mock `./dispatch-rollup` in that test file with `vi.mock("./dispatch-rollup", () => ({ getDispatchOutcomeRollup: vi.fn(async () => ({ days: 7, real: {committed:0,queuedAmbiguous:0,queuedNoFit:0,queuedNeedsReview:0,total:0}, shadow: {committed:0,queuedAmbiguous:0,queuedNoFit:0,queuedNeedsReview:0,total:0}, overrides: 0, commitRate: null })) }))`. Prefer the mock approach (isolates the operations test from the rollup's query shape).

- [ ] **Step 7: Commit.**
```bash
git add src/lib/admin/dispatch-rollup.ts src/lib/admin/dispatch-rollup.test.ts src/lib/admin/operations-metrics-types.ts src/lib/admin/operations-metrics-queries.ts src/lib/admin/operations-metrics-queries.test.ts src/hooks/use-operations-metrics.ts "src/app/admin/(dashboard)/operations/page.tsx"
git commit -m "$(cat <<'EOF'
feat(dispatch): outcome rollup helper + Operations dispatch-health card

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Weekly digest cron + canary + register delay-sweep

New `/api/cron/dispatch-digest` route follows the delay-sweep auth + per-org try/catch pattern exactly: per org, compute the rollup for this-week and trailing-28-day, apply the collapse rule (this-week commit rate < 50% of trailing rate with ≥20 decisions in EACH window), SMS the `dispatch_alert_phone` (log-only when unset). Add BOTH cron entries to `vercel.json` (dispatch-digest weekly + the missing delay-sweep every 15 min).

**Files:**
- Create: `src/app/api/cron/dispatch-digest/route.ts`
- Create: `tests/api/cron/dispatch-digest.test.ts`
- Modify: `vercel.json` (two new cron entries)

**Interfaces:**
- Consumes: `getDispatchOutcomeRollup` (Task 4); `verifyCronAuth`; `sendSms`; `organizationSettings.dispatchAlertPhone`; `successResponse`/`errorResponse`; `logger`.
- Produces: `GET /api/cron/dispatch-digest` → `successResponse({ orgsChecked, alertsSent })`.

- [ ] **Step 1: Write the failing test.** Create `tests/api/cron/dispatch-digest.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyCronAuth,
  mockGetRollup,
  mockSendSms,
  mockSelect,
  selectQueue,
  loggerError,
} = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const chain = (resolved: unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then")
          return (resolve: (v: unknown) => void) => resolve(resolved);
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };
  return {
    mockVerifyCronAuth: vi.fn(() => true),
    mockGetRollup: vi.fn(),
    mockSendSms: vi.fn(async () => ({ sid: "SM1" })),
    mockSelect: () => chain(selectQueue.shift() ?? []),
    selectQueue,
    loggerError: vi.fn(),
  };
});

vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: mockVerifyCronAuth }));
vi.mock("@/lib/admin/dispatch-rollup", () => ({
  getDispatchOutcomeRollup: (...a: unknown[]) => mockGetRollup(...a),
}));
vi.mock("@/lib/communication/twilio-adapter", () => ({ sendSms: mockSendSms }));
vi.mock("@/lib/db", () => ({ db: { select: () => mockSelect() } }));
vi.mock("@/lib/db/schema", () => ({
  organizationSettings: {
    organizationId: "os.org",
    dispatchAlertPhone: "os.phone",
  },
}));
vi.mock("drizzle-orm", () => ({
  isNotNull: (c: unknown) => ["isNotNull", c],
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: loggerError, info: vi.fn(), warn: vi.fn() },
}));

import { GET } from "@/app/api/cron/dispatch-digest/route";

function req(): NextRequest {
  return new NextRequest("http://localhost/api/cron/dispatch-digest", {
    headers: { authorization: "Bearer test-secret" },
  });
}

const ORG = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  process.env.CRON_SECRET = "test-secret";
  mockVerifyCronAuth.mockReturnValue(true);
});

describe("GET /api/cron/dispatch-digest", () => {
  it("returns 401 when cron auth fails", async () => {
    mockVerifyCronAuth.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("alerts on a collapse (this-week rate < 50% of trailing, >=20 each)", async () => {
    selectQueue.push([{ organizationId: ORG, phone: "+15551234567" }]);
    // 1st call = this week (low commit rate), 2nd = trailing-28d (high).
    mockGetRollup
      .mockResolvedValueOnce({
        days: 7,
        real: { committed: 4, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 20 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.2,
      })
      .mockResolvedValueOnce({
        days: 28,
        real: { committed: 80, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 100 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.8,
      });
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockSendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+15551234567" }),
    );
    expect(body.data.alertsSent).toBe(1);
  });

  it("does NOT alert when the trailing window has < 20 decisions", async () => {
    selectQueue.push([{ organizationId: ORG, phone: "+15551234567" }]);
    mockGetRollup
      .mockResolvedValueOnce({
        days: 7,
        real: { committed: 1, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 20 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.05,
      })
      .mockResolvedValueOnce({
        days: 28,
        real: { committed: 10, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 15 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.67,
      });
    const res = await GET(req());
    const body = await res.json();
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(body.data.alertsSent).toBe(0);
  });

  it("does NOT alert when THIS WEEK's window has < 20 decisions", async () => {
    // Trailing window has plenty (>=20) but this week is too sparse to judge —
    // a slow week must not page the dispatcher.
    selectQueue.push([{ organizationId: ORG, phone: "+15551234567" }]);
    mockGetRollup
      .mockResolvedValueOnce({
        days: 7,
        real: { committed: 1, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 12 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.08,
      })
      .mockResolvedValueOnce({
        days: 28,
        real: { committed: 80, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 100 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.8,
      });
    const res = await GET(req());
    const body = await res.json();
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(body.data.alertsSent).toBe(0);
  });

  it("one org's sendSms failure does not abort the run", async () => {
    selectQueue.push([
      { organizationId: ORG, phone: "+15551110000" },
      { organizationId: ORG, phone: "+15552220000" },
    ]);
    // Both orgs collapse; the first send throws (e.g. TWILIO_PHONE_NUMBER unset).
    const collapse = [
      {
        days: 7,
        real: { committed: 2, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 20 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.1,
      },
      {
        days: 28,
        real: { committed: 90, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 100 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.9,
      },
    ];
    mockGetRollup.mockResolvedValue(collapse[0]);
    // Alternate week/trailing per org via sequence.
    mockGetRollup
      .mockResolvedValueOnce(collapse[0])
      .mockResolvedValueOnce(collapse[1])
      .mockResolvedValueOnce(collapse[0])
      .mockResolvedValueOnce(collapse[1]);
    mockSendSms.mockRejectedValueOnce(new Error("TWILIO_PHONE_NUMBER not set"));
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200); // run completed despite the first failure
    expect(mockSendSms).toHaveBeenCalledTimes(2); // both orgs attempted
    expect(loggerError).toHaveBeenCalled();
    expect(body.data.alertsSent).toBe(1); // only the second succeeded
  });
});
```

- [ ] **Step 2: Run to see it fail.**
```bash
npx vitest run tests/api/cron/dispatch-digest.test.ts
```
Expected failure: `Failed to resolve import "@/app/api/cron/dispatch-digest/route"`.

- [ ] **Step 3: Implement the cron route.** Create `src/app/api/cron/dispatch-digest/route.ts`:
```ts
import { NextRequest } from "next/server";
import { isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizationSettings } from "@/lib/db/schema";
import { getDispatchOutcomeRollup } from "@/lib/admin/dispatch-rollup";
import { sendSms } from "@/lib/communication/twilio-adapter";
import { successResponse, errorResponse } from "@/lib/api-response";
import { verifyCronAuth } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Minimum decisions in EACH window before a collapse is trustworthy — guards the
// empty/near-empty denominator so a slow week can't page the dispatcher.
const MIN_DECISIONS = 20;
// This week's commit rate below this fraction of the trailing-28-day rate = collapse.
const COLLAPSE_FRACTION = 0.5;
const WEEK_DAYS = 7;
const TRAILING_DAYS = 28;

/** A short dispatch-health alert. PII-free: rates + counts only. */
function alertBody(weekRate: number, trailingRate: number): string {
  return `Dispatch alert: auto-commit rate fell to ${Math.round(
    weekRate * 100,
  )}% this week (28-day baseline ${Math.round(
    trailingRate * 100,
  )}%). Check geocoding/signals or a recent weight change.`;
}

/**
 * GET /api/cron/dispatch-digest — weekly canary. For each org with a dispatch
 * alert number, compare this week's commit rate to the trailing-28-day rate
 * (over real + shadow decisions together) and SMS a collapse alert. Cron-secret
 * authenticated; per-org try/catch so one org's config can't abort the run
 * (sendSms THROWS without TWILIO_PHONE_NUMBER).
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    return errorResponse("Cron endpoint not configured", "NOT_CONFIGURED", 503);
  }
  if (!verifyCronAuth(request.headers.get("authorization"))) {
    return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
  }

  try {
    // Only orgs that have opted in by setting a dispatch alert number.
    const orgs = await db
      .select({
        organizationId: organizationSettings.organizationId,
        phone: organizationSettings.dispatchAlertPhone,
      })
      .from(organizationSettings)
      .where(isNotNull(organizationSettings.dispatchAlertPhone));

    let alerted = 0;
    for (const org of orgs) {
      try {
        const [week, trailing] = await Promise.all([
          getDispatchOutcomeRollup(org.organizationId, WEEK_DAYS),
          getDispatchOutcomeRollup(org.organizationId, TRAILING_DAYS),
        ]);

        // Need enough signal in BOTH windows, and non-null rates, to judge a collapse.
        if (
          week.real.total + week.shadow.total < MIN_DECISIONS ||
          trailing.real.total + trailing.shadow.total < MIN_DECISIONS ||
          week.commitRate === null ||
          trailing.commitRate === null
        ) {
          continue;
        }

        const collapsed =
          week.commitRate < COLLAPSE_FRACTION * trailing.commitRate;
        if (!collapsed) continue;

        if (!org.phone) {
          // Log-only when no alert phone (can't happen given the WHERE, but keep
          // the guard so a future query change fails safe).
          logger.info(
            { organizationId: org.organizationId },
            "dispatch-digest: collapse detected but no alert phone",
          );
          continue;
        }

        await sendSms({
          to: org.phone,
          body: alertBody(week.commitRate, trailing.commitRate),
        });
        alerted += 1;
      } catch (error) {
        // One org's config/send failure must not abort the sweep. sendSms throws
        // when TWILIO_PHONE_NUMBER is unset — log and continue.
        logger.error(
          { error, organizationId: org.organizationId },
          "dispatch-digest: failed to evaluate/alert for org",
        );
        continue;
      }
    }

    return successResponse({ orgsChecked: orgs.length, alertsSent: alerted });
  } catch (error) {
    logger.error({ error }, "dispatch-digest failed");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

- [ ] **Step 4: Register BOTH crons in `vercel.json`.** In the `"crons"` array, add two entries (append after the existing `sync-housecall-invoices` entry — add a comma after its closing brace):
```json
    {
      "path": "/api/cron/delay-sweep",
      "schedule": "*/15 * * * *"
    },
    {
      "path": "/api/cron/dispatch-digest",
      "schedule": "0 12 * * 1"
    }
```
(delay-sweep every 15 minutes — near-real-time dispatcher alerts, matching its "bump to a few minutes on Pro" design note; dispatch-digest Mondays at noon UTC.)

- [ ] **Step 5: Run to pass.**
```bash
npx vitest run tests/api/cron/dispatch-digest.test.ts
```
Expected: green. Confirm `vercel.json` is valid JSON: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'));console.log('ok')"`.

- [ ] **Step 6: Run the full gate.**
```bash
npx tsc --noEmit
npx eslint "src/app/api/cron/dispatch-digest/route.ts" tests/api/cron/dispatch-digest.test.ts
```

- [ ] **Step 7: Commit.**
```bash
git add "src/app/api/cron/dispatch-digest/route.ts" tests/api/cron/dispatch-digest.test.ts vercel.json
git commit -m "$(cat <<'EOF'
feat(dispatch): weekly digest canary cron + register delay-sweep cron

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: "Why this tech?" decision panel

New `GET /api/admin/requests/[id]/decision` returns the latest decision row (via a new `getDispatchDecisionForRequest` query that resolves candidate tech UUIDs → display names with one `inArray` lookup). Each candidate's `skillMatched` is READ from the stored candidate field (recorded in Task 3) — never re-derived from reason text; legacy rows without it surface `null` (unknown, no indicator). A collapsible "Dispatch decision" section renders it in the request detail sheet for requests that have a row (shadow rows labeled "preview"). Add `travelKm`/`travelMinutes` to the client `DispatchSuggestion` type.

**Files:**
- Create: `src/lib/admin/dispatch-decision-queries.ts`
- Create: `src/lib/admin/dispatch-decision-queries.test.ts`
- Create: `src/app/api/admin/requests/[id]/decision/route.ts`
- Create: `tests/api/admin/requests-decision.test.ts`
- Modify: `src/components/admin/request-detail-sheet.tsx` (add the section + travel fields on `DispatchSuggestion`)

**Interfaces:**
- Consumes: `dispatchDecisions` (all columns), `users` (name lookup); `getAdminSession`, `isUuid`.
- Produces:
```ts
interface DispatchDecisionCandidate {
  readonly technicianId: string;
  readonly name: string | null;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly travelKm: number | null;
  readonly travelMinutes: number | null;
  /** From the stored candidate field; null for legacy rows (unknown). */
  readonly skillMatched: boolean | null;
}
interface DispatchDecisionView {
  readonly outcome: string;
  readonly isShadow: boolean;
  readonly chosenTechnicianId: string | null;
  readonly topScore: number | null;
  readonly confidenceGap: number | null;
  readonly createdAt: string;
  readonly overriddenTechnicianId: string | null;
  readonly overriddenByUserId: string | null;
  readonly overriddenAt: string | null;
  readonly candidates: readonly DispatchDecisionCandidate[];
}
```
  `getDispatchDecisionForRequest(organizationId: string, requestId: string): Promise<DispatchDecisionView | null>`. `GET /api/admin/requests/[id]/decision` → `successResponse(DispatchDecisionView)` or 404 when no row.

- [ ] **Step 1: Write the failing query test.** Create `src/lib/admin/dispatch-decision-queries.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { selectQueue, whereCalls, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const whereCalls: unknown[][] = [];
  const chain = (resolved: unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then")
          return (resolve: (v: unknown) => void) => resolve(resolved);
        if (prop === "where")
          return (...args: unknown[]) => {
            whereCalls.push(args);
            return p;
          };
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };
  return { selectQueue, whereCalls, chain };
});

vi.mock("@/lib/db", () => ({
  db: { select: () => chain(selectQueue.shift() ?? []) },
}));
vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_t: unknown, orgId: string, ...conditions: unknown[]) => ({
    __tenant: orgId,
    conditions,
  }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ["and", ...a],
  eq: (...a: unknown[]) => ["eq", ...a],
  desc: (c: unknown) => c,
  inArray: (...a: unknown[]) => ["inArray", ...a],
}));
vi.mock("@/lib/db/schema", () => ({
  dispatchDecisions: {
    id: "dd.id",
    organizationId: "dd.org",
    serviceRequestId: "dd.req",
    outcome: "dd.outcome",
    isShadow: "dd.shadow",
    chosenTechnicianId: "dd.chosen",
    topScore: "dd.top",
    confidenceGap: "dd.gap",
    candidates: "dd.cands",
    createdAt: "dd.created",
    overriddenTechnicianId: "dd.overTech",
    overriddenByUserId: "dd.overBy",
    overriddenAt: "dd.overAt",
  },
  users: { id: "u.id", organizationId: "u.org", name: "u.name" },
}));

import { getDispatchDecisionForRequest } from "./dispatch-decision-queries";

const ORG = "00000000-0000-0000-0000-000000000001";
const REQ = "00000000-0000-0000-0000-0000000000b1";
const T1 = "00000000-0000-0000-0000-0000000000a1";
const T2 = "00000000-0000-0000-0000-0000000000a2";
const T3 = "00000000-0000-0000-0000-0000000000a3";

beforeEach(() => {
  selectQueue.length = 0;
  whereCalls.length = 0;
});

describe("getDispatchDecisionForRequest", () => {
  it("returns the latest row with candidate names + STORED skillMatched (absent → null)", async () => {
    selectQueue.push([
      {
        outcome: "committed",
        isShadow: false,
        chosenTechnicianId: T1,
        topScore: 0.82,
        confidenceGap: 0.12,
        createdAt: new Date("2026-07-20T10:00:00Z"),
        overriddenTechnicianId: null,
        overriddenByUserId: null,
        overriddenAt: null,
        candidates: [
          // Stored true.
          { technicianId: T1, score: 0.82, reasons: ["5 prior jobs"], travelKm: 3.2, travelMinutes: 8, skillMatched: true },
          // Stored false.
          { technicianId: T2, score: 0.7, reasons: ["no prior experience"], travelKm: null, travelMinutes: null, skillMatched: false },
          // Legacy row: skillMatched key ABSENT → surfaces as null (unknown).
          { technicianId: T3, score: 0.6, reasons: ["2 prior jobs"], travelKm: null, travelMinutes: null },
        ],
      },
    ]);
    selectQueue.push([
      { id: T1, name: "Alice" },
      { id: T2, name: "Bob" },
      { id: T3, name: "Carol" },
    ]);
    const view = await getDispatchDecisionForRequest(ORG, REQ);
    expect(view).not.toBeNull();
    expect(view!.outcome).toBe("committed");
    expect(view!.isShadow).toBe(false);
    expect(view!.chosenTechnicianId).toBe(T1);
    expect(view!.createdAt).toBe("2026-07-20T10:00:00.000Z");
    expect(view!.candidates).toHaveLength(3);
    expect(view!.candidates[0]).toMatchObject({
      technicianId: T1,
      name: "Alice",
      score: 0.82,
      travelKm: 3.2,
      travelMinutes: 8,
      skillMatched: true, // read from the stored field
    });
    expect(view!.candidates[1]).toMatchObject({ name: "Bob", skillMatched: false });
    // Legacy candidate: stored field absent → null (unknown), never guessed.
    expect(view!.candidates[2]).toMatchObject({ name: "Carol", skillMatched: null });
    expect((whereCalls[0][0] as { __tenant: string }).__tenant).toBe(ORG);
  });

  it("returns null when there is no decision row", async () => {
    selectQueue.push([]);
    const view = await getDispatchDecisionForRequest(ORG, REQ);
    expect(view).toBeNull();
  });
});
```
  Note: `skillMatched` is READ from the stored candidate field (recorded by `recordDispatchDecision` in Task 3). Legacy rows recorded before that field existed lack the key → the helper surfaces `null` (unknown), never re-derived from reason text.

- [ ] **Step 2: Run to see it fail.**
```bash
npx vitest run src/lib/admin/dispatch-decision-queries.test.ts
```
Expected failure: `Failed to resolve import "./dispatch-decision-queries"`.

- [ ] **Step 3: Implement the query.** Create `src/lib/admin/dispatch-decision-queries.ts`:
```ts
/**
 * Read the recorded dispatch decision for a request — the "why this tech?" data.
 * Latest row (created_at DESC LIMIT 1), tenant-scoped. The candidates JSONB stores
 * tech UUIDs only, so we resolve display names with ONE org-scoped inArray lookup
 * over users. skillMatched is read straight from the STORED candidate field
 * (recorded by recordDispatchDecision) — never re-derived from reason text. Rows
 * recorded before that field existed lack the key: we surface it as `null`
 * (unknown) rather than guessing. Read-only.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { dispatchDecisions, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface DispatchDecisionCandidate {
  readonly technicianId: string;
  readonly name: string | null;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly travelKm: number | null;
  readonly travelMinutes: number | null;
  /** true/false from the stored candidate; null for legacy rows recorded before
   * skillMatched was stored (unknown — the panel renders no indicator). */
  readonly skillMatched: boolean | null;
}

export interface DispatchDecisionView {
  readonly outcome: string;
  readonly isShadow: boolean;
  readonly chosenTechnicianId: string | null;
  readonly topScore: number | null;
  readonly confidenceGap: number | null;
  readonly createdAt: string;
  readonly overriddenTechnicianId: string | null;
  readonly overriddenByUserId: string | null;
  readonly overriddenAt: string | null;
  readonly candidates: readonly DispatchDecisionCandidate[];
}

export async function getDispatchDecisionForRequest(
  organizationId: string,
  requestId: string,
): Promise<DispatchDecisionView | null> {
  const [row] = await db
    .select({
      outcome: dispatchDecisions.outcome,
      isShadow: dispatchDecisions.isShadow,
      chosenTechnicianId: dispatchDecisions.chosenTechnicianId,
      topScore: dispatchDecisions.topScore,
      confidenceGap: dispatchDecisions.confidenceGap,
      candidates: dispatchDecisions.candidates,
      createdAt: dispatchDecisions.createdAt,
      overriddenTechnicianId: dispatchDecisions.overriddenTechnicianId,
      overriddenByUserId: dispatchDecisions.overriddenByUserId,
      overriddenAt: dispatchDecisions.overriddenAt,
    })
    .from(dispatchDecisions)
    .where(
      withTenant(
        dispatchDecisions,
        organizationId,
        eq(dispatchDecisions.serviceRequestId, requestId),
      ),
    )
    .orderBy(desc(dispatchDecisions.createdAt))
    .limit(1);

  if (!row) return null;

  const rawCandidates = row.candidates ?? [];
  const techIds = [...new Set(rawCandidates.map((c) => c.technicianId))];
  const nameById = new Map<string, string>();
  if (techIds.length > 0) {
    const nameRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(withTenant(users, organizationId, inArray(users.id, techIds)));
    for (const n of nameRows) nameById.set(n.id, n.name);
  }

  const candidates: DispatchDecisionCandidate[] = rawCandidates.map((c) => ({
    technicianId: c.technicianId,
    name: nameById.get(c.technicianId) ?? null,
    score: c.score,
    reasons: c.reasons,
    travelKm: c.travelKm ?? null,
    travelMinutes: c.travelMinutes ?? null,
    // Read the STORED flag; absent (legacy row) → null (unknown, not guessed).
    skillMatched: typeof c.skillMatched === "boolean" ? c.skillMatched : null,
  }));

  return {
    outcome: row.outcome,
    isShadow: row.isShadow,
    chosenTechnicianId: row.chosenTechnicianId,
    topScore: row.topScore,
    confidenceGap: row.confidenceGap,
    createdAt: row.createdAt.toISOString(),
    overriddenTechnicianId: row.overriddenTechnicianId,
    overriddenByUserId: row.overriddenByUserId,
    overriddenAt: row.overriddenAt ? row.overriddenAt.toISOString() : null,
    candidates,
  };
}
```

- [ ] **Step 4: Run the query test to pass.**
```bash
npx vitest run src/lib/admin/dispatch-decision-queries.test.ts
```
Expected: green.

- [ ] **Step 5: Write the failing route test.** Create `tests/api/admin/requests-decision.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetAdminSession, mockGetDecision } = vi.hoisted(() => ({
  mockGetAdminSession: vi.fn(),
  mockGetDecision: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
}));
vi.mock("@/lib/admin/dispatch-decision-queries", () => ({
  getDispatchDecisionForRequest: (...a: unknown[]) => mockGetDecision(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

import { GET } from "@/app/api/admin/requests/[id]/decision/route";

const session = {
  userId: "u1",
  organizationId: "org-1",
  email: "a@b.c",
  name: "A",
  role: "admin" as const,
};
const VALID = "550e8400-e29b-41d4-a716-446655440000";

function req(): NextRequest {
  return new NextRequest(`http://localhost/api/admin/requests/${VALID}/decision`);
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/admin/requests/[id]/decision", () => {
  it("401 when unauthenticated", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await GET(req(), { params: Promise.resolve({ id: VALID }) });
    expect(res.status).toBe(401);
  });

  it("400 on a non-UUID id", async () => {
    mockGetAdminSession.mockResolvedValue(session);
    const res = await GET(req(), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when there is no decision row", async () => {
    mockGetAdminSession.mockResolvedValue(session);
    mockGetDecision.mockResolvedValue(null);
    const res = await GET(req(), { params: Promise.resolve({ id: VALID }) });
    expect(res.status).toBe(404);
  });

  it("200 with the decision view", async () => {
    mockGetAdminSession.mockResolvedValue(session);
    mockGetDecision.mockResolvedValue({
      outcome: "committed",
      isShadow: false,
      chosenTechnicianId: "t1",
      topScore: 0.8,
      confidenceGap: 0.1,
      createdAt: "2026-07-20T10:00:00.000Z",
      overriddenTechnicianId: null,
      overriddenByUserId: null,
      overriddenAt: null,
      candidates: [],
    });
    const res = await GET(req(), { params: Promise.resolve({ id: VALID }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.outcome).toBe("committed");
    expect(mockGetDecision).toHaveBeenCalledWith("org-1", VALID);
  });
});
```

- [ ] **Step 6: Run to see it fail.**
```bash
npx vitest run tests/api/admin/requests-decision.test.ts
```
Expected failure: `Failed to resolve import "@/app/api/admin/requests/[id]/decision/route"`.

- [ ] **Step 7: Implement the route.** Create `src/app/api/admin/requests/[id]/decision/route.ts`:
```ts
import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getDispatchDecisionForRequest } from "@/lib/admin/dispatch-decision-queries";
import { isUuid } from "@/lib/validation/uuid";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/admin/requests/[id]/decision — the RECORDED dispatch decision for a
 * request (why this tech?). Admin-session gated, org from session, UUID-guarded.
 * Returns the latest decision row (real or shadow); 404 when none exists.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { id } = await params;
    if (!isUuid(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }
    const decision = await getDispatchDecisionForRequest(
      session.organizationId,
      id,
    );
    if (!decision) {
      return errorResponse("No dispatch decision recorded", "NOT_FOUND", 404);
    }
    return successResponse(decision);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to load dispatch decision");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

- [ ] **Step 8: Render the section + add travel fields to `DispatchSuggestion`.** In `src/components/admin/request-detail-sheet.tsx`:
  1. Extend the `DispatchSuggestion` interface (~line 195) to add the two travel fields:
```ts
interface DispatchSuggestion {
  readonly technicianId: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly skillMatched: boolean;
  readonly travelKm: number | null;
  readonly travelMinutes: number | null;
}
```
  2. Add a client type + state + fetch for the decision. Near the other type declarations add:
```ts
interface DispatchDecisionCandidateView {
  readonly technicianId: string;
  readonly name: string | null;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly travelKm: number | null;
  readonly travelMinutes: number | null;
  // null = unknown (legacy row without the stored flag) → render no indicator.
  readonly skillMatched: boolean | null;
}
interface DispatchDecisionView {
  readonly outcome: string;
  readonly isShadow: boolean;
  readonly chosenTechnicianId: string | null;
  readonly topScore: number | null;
  readonly confidenceGap: number | null;
  readonly createdAt: string;
  readonly overriddenTechnicianId: string | null;
  readonly overriddenByUserId: string | null;
  readonly overriddenAt: string | null;
  readonly candidates: readonly DispatchDecisionCandidateView[];
}
```
  Inside the component add state (near the other `useState` calls) and open-state:
```ts
  const [decision, setDecision] = useState<DispatchDecisionView | null>(null);
  const [decisionOpen, setDecisionOpen] = useState(false);
```
  In the effect that loads suggestions (or a sibling effect keyed on `requestId`), add a fetch — mirror the suggestions fetch pattern (guarded with `cancelled`, non-fatal):
```ts
    async function loadDecision(): Promise<void> {
      try {
        const res = await fetch(`/api/admin/requests/${requestId}/decision`);
        if (!res.ok) {
          if (!cancelled) setDecision(null);
          return;
        }
        const body = (await res.json()) as {
          success: boolean;
          data: DispatchDecisionView;
        };
        if (!cancelled && body.success) setDecision(body.data);
      } catch {
        // Non-fatal: no decision section.
      }
    }
    void loadDecision();
```
  Ensure `setDecision(null)` runs when `requestId` changes (reset before the fetch). Then render a collapsible section (mirror the FieldPulse-metrics collapsible pattern; only when `decision` is non-null). Place it near the "Suggested technicians" card:
```tsx
      {decision && (
        <section>
          <div className="rounded-md border border-sky-200 bg-sky-50/40">
            <button
              type="button"
              aria-expanded={decisionOpen}
              onClick={() => setDecisionOpen((v) => !v)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-sky-800 hover:bg-sky-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
            >
              {decisionOpen ? (
                <ChevronDown className="size-3.5 shrink-0 text-sky-600" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-sky-600" aria-hidden="true" />
              )}
              <span>Dispatch decision</span>
              {decision.isShadow && (
                <span className="rounded border border-sky-300 bg-sky-100 px-1.5 py-px text-[10px] font-medium text-sky-700">
                  preview
                </span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {decision.outcome}
              </span>
            </button>
            {decisionOpen && (
              <div className="border-t border-sky-200 px-3 pb-3 pt-2 space-y-2">
                <div className="text-xs text-muted-foreground">
                  {decision.topScore != null && (
                    <>top score {decision.topScore.toFixed(2)}</>
                  )}
                  {decision.confidenceGap != null && (
                    <> · gap {decision.confidenceGap.toFixed(2)}</>
                  )}
                  {decision.overriddenAt && <> · overridden by dispatcher</>}
                </div>
                <ul className="space-y-1.5">
                  {decision.candidates.map((c) => (
                    <li key={c.technicianId} className="text-xs">
                      <span className="font-medium text-foreground">
                        {c.name ?? c.technicianId}
                      </span>{' '}
                      · {c.score.toFixed(2)}
                      {c.travelMinutes != null
                        ? ` · ~${Math.round(c.travelMinutes)} min`
                        : c.travelKm != null
                          ? ` · ${c.travelKm.toFixed(1)} km`
                          : ''}
                      <div className="text-muted-foreground">
                        {c.reasons.join(' · ')}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}
```
  Ensure `ChevronDown` and `ChevronRight` are already imported in the file (they are — used by the FieldPulse collapsible). If not, add them to the lucide import.

- [ ] **Step 9: Run to pass.**
```bash
npx vitest run tests/api/admin/requests-decision.test.ts src/lib/admin/dispatch-decision-queries.test.ts
```
Expected: green. (No component test — repo policy: no jsdom/RTL.)

- [ ] **Step 10: Run the full gate.**
```bash
npx tsc --noEmit
npx eslint src/lib/admin/dispatch-decision-queries.ts src/lib/admin/dispatch-decision-queries.test.ts "src/app/api/admin/requests/[id]/decision/route.ts" tests/api/admin/requests-decision.test.ts src/components/admin/request-detail-sheet.tsx
```

- [ ] **Step 11: Commit.**
```bash
git add src/lib/admin/dispatch-decision-queries.ts src/lib/admin/dispatch-decision-queries.test.ts "src/app/api/admin/requests/[id]/decision/route.ts" tests/api/admin/requests-decision.test.ts src/components/admin/request-detail-sheet.tsx
git commit -m "$(cat <<'EOF'
feat(dispatch): why-this-tech decision panel (route + query + sheet section)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Exceptions rail

New day-independent `getDispatchExceptions(organizationId, limit=20)` (unassigned + `auto_dispatch_outcome LIKE 'queued_%'` + status not cancelled/completed, ordered `createdAt` ASC) exposed via the dispatch board API payload. The board page renders an "Exceptions" section (outcome badge + age; row click opens the existing detail sheet).

**Files:**
- Create: `src/lib/admin/dispatch-exceptions-queries.ts`
- Create: `src/lib/admin/dispatch-exceptions-queries.test.ts`
- Modify: `src/app/api/admin/dispatch/route.ts` (call the query, add to payload)
- Modify: `src/hooks/use-dispatch-board.ts` (extend the payload type)
- Modify: `src/app/admin/(dashboard)/dispatch/page.tsx` (render the rail)

**Interfaces:**
- Consumes: `serviceRequests`, `users` (assignee name — always null here since unassigned, so skip join); `withTenant`.
- Produces:
```ts
interface DispatchException {
  readonly id: string;
  readonly referenceNumber: string;
  readonly issueType: string;
  readonly urgency: string;
  readonly autoDispatchOutcome: string;
  readonly createdAt: string;
}
```
  `getDispatchExceptions(organizationId: string, limit?: number): Promise<readonly DispatchException[]>`. The `/api/admin/dispatch` payload gains `exceptions: readonly DispatchException[]`.

- [ ] **Step 1: Write the failing query test.** Create `src/lib/admin/dispatch-exceptions-queries.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { selectQueue, whereCalls, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const whereCalls: unknown[][] = [];
  const chain = (resolved: unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then")
          return (resolve: (v: unknown) => void) => resolve(resolved);
        if (prop === "where")
          return (...args: unknown[]) => {
            whereCalls.push(args);
            return p;
          };
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };
  return { selectQueue, whereCalls, chain };
});

vi.mock("@/lib/db", () => ({
  db: { select: () => chain(selectQueue.shift() ?? []) },
}));
vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_t: unknown, orgId: string, ...conditions: unknown[]) => ({
    __tenant: orgId,
    conditions,
  }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ["and", ...a],
  asc: (c: unknown) => c,
  eq: (...a: unknown[]) => ["eq", ...a],
  isNull: (c: unknown) => ["isNull", c],
  notInArray: (...a: unknown[]) => ["notInArray", ...a],
  like: (...a: unknown[]) => ["like", ...a],
}));
vi.mock("@/lib/db/schema", () => ({
  serviceRequests: {
    id: "sr.id",
    organizationId: "sr.org",
    referenceNumber: "sr.ref",
    issueType: "sr.issue",
    urgency: "sr.urgency",
    status: "sr.status",
    assignedTo: "sr.assignedTo",
    autoDispatchOutcome: "sr.outcome",
    createdAt: "sr.created",
  },
}));

import { getDispatchExceptions } from "./dispatch-exceptions-queries";

const ORG = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  selectQueue.length = 0;
  whereCalls.length = 0;
});

describe("getDispatchExceptions", () => {
  it("maps queued+unassigned rows, oldest first, tenant-scoped", async () => {
    selectQueue.push([
      {
        id: "r1",
        referenceNumber: "REF-1",
        issueType: "no_cool",
        urgency: "standard",
        autoDispatchOutcome: "queued_ambiguous",
        createdAt: new Date("2026-07-20T10:00:00Z"),
      },
    ]);
    const rows = await getDispatchExceptions(ORG);
    expect(rows).toEqual([
      {
        id: "r1",
        referenceNumber: "REF-1",
        issueType: "no_cool",
        urgency: "standard",
        autoDispatchOutcome: "queued_ambiguous",
        createdAt: "2026-07-20T10:00:00.000Z",
      },
    ]);
    const conds = (whereCalls[0][0] as { conditions: unknown[] }).conditions;
    expect((whereCalls[0][0] as { __tenant: string }).__tenant).toBe(ORG);
    // Unassigned + like queued_% + status not cancelled/completed.
    expect(conds).toContainEqual(["isNull", "sr.assignedTo"]);
    expect(conds).toContainEqual(["like", "sr.outcome", "queued_%"]);
    expect(
      conds.some((c) => Array.isArray(c) && c[0] === "notInArray"),
    ).toBe(true);
  });

  it("returns [] when nothing is queued", async () => {
    selectQueue.push([]);
    expect(await getDispatchExceptions(ORG)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to see it fail.**
```bash
npx vitest run src/lib/admin/dispatch-exceptions-queries.test.ts
```
Expected failure: `Failed to resolve import "./dispatch-exceptions-queries"`.

- [ ] **Step 3: Implement the query.** Create `src/lib/admin/dispatch-exceptions-queries.ts`:
```ts
/**
 * Exceptions rail — the queued auto-dispatch jobs a dispatcher needs to resolve.
 *
 * DELIBERATELY day-independent (unlike getDispatchBoard, which is bounded to the
 * selected day and requires a non-null arrival window). A queued job may have no
 * window yet and may have been queued yesterday, so it must not scroll out of
 * sight: this query filters on unassigned + auto_dispatch_outcome queued_* +
 * non-terminal status, oldest first, capped. Tenant-scoped.
 */
import { and, asc, eq, isNull, like, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface DispatchException {
  readonly id: string;
  readonly referenceNumber: string;
  readonly issueType: string;
  readonly urgency: string;
  readonly autoDispatchOutcome: string;
  readonly createdAt: string;
}

const TERMINAL_STATUSES = ["completed", "cancelled"] as const;

export async function getDispatchExceptions(
  organizationId: string,
  limit = 20,
): Promise<readonly DispatchException[]> {
  const rows = await db
    .select({
      id: serviceRequests.id,
      referenceNumber: serviceRequests.referenceNumber,
      issueType: serviceRequests.issueType,
      urgency: serviceRequests.urgency,
      autoDispatchOutcome: serviceRequests.autoDispatchOutcome,
      createdAt: serviceRequests.createdAt,
    })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          isNull(serviceRequests.assignedTo),
          like(serviceRequests.autoDispatchOutcome, "queued_%"),
          notInArray(serviceRequests.status, [...TERMINAL_STATUSES]),
        )!,
      ),
    )
    .orderBy(asc(serviceRequests.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    referenceNumber: r.referenceNumber,
    issueType: r.issueType,
    urgency: r.urgency,
    autoDispatchOutcome: r.autoDispatchOutcome ?? "",
    createdAt: r.createdAt.toISOString(),
  }));
}
```

- [ ] **Step 4: Run the query test to pass.**
```bash
npx vitest run src/lib/admin/dispatch-exceptions-queries.test.ts
```
Expected: green.

- [ ] **Step 5: Expose via the board API payload.** In `src/app/api/admin/dispatch/route.ts`:
  1. Add the import: `import { getDispatchExceptions } from "@/lib/admin/dispatch-exceptions-queries";`
  2. Replace the board fetch + response with a combined payload. Enumerate the board's actual fields explicitly (`getDispatchBoard` returns `DispatchBoard = { date, columns, unassigned }` — verified in `src/lib/admin/types.ts:224`) plus `exceptions`, so a spread can't silently clobber or leak a renamed field:
```ts
    const date = request.nextUrl.searchParams.get("date") ?? undefined;
    const [board, exceptions] = await Promise.all([
      getDispatchBoard(session.organizationId, date),
      getDispatchExceptions(session.organizationId),
    ]);
    return successResponse({
      date: board.date,
      columns: board.columns,
      unassigned: board.unassigned,
      exceptions,
    });
```

- [ ] **Step 6: Extend the client payload type.** In `src/hooks/use-dispatch-board.ts`:
  1. After the imports, add a client type:
```ts
export interface DispatchException {
  readonly id: string;
  readonly referenceNumber: string;
  readonly issueType: string;
  readonly urgency: string;
  readonly autoDispatchOutcome: string;
  readonly createdAt: string;
}

export type DispatchBoardWithExceptions = DispatchBoard & {
  readonly exceptions: readonly DispatchException[];
};
```
  2. Change the state + result types from `DispatchBoard` to `DispatchBoardWithExceptions`:
```ts
interface UseDispatchBoardResult {
  readonly board: DispatchBoardWithExceptions | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refetch: () => Promise<void>;
}
```
  3. Change the `useState` initializer to the new type:
```ts
  const [board, setBoard] = useState<DispatchBoardWithExceptions | null>(null);
```
  4. Change the `res.json()` cast at the successful-response site (currently `data: DispatchBoard`, ~line 47-50) to the exceptions-bearing type:
```ts
      const body = (await res.json()) as {
        success: boolean;
        data: DispatchBoardWithExceptions;
      };
```

- [ ] **Step 7: Render the rail.** In `src/app/admin/(dashboard)/dispatch/page.tsx`, add an "Exceptions" section above the board columns (after the error `Alert`, before the `isLoading ? ... : ...` block). Rows reuse `setSelectedRequestId` to open the existing sheet:
```tsx
      {board && board.exceptions.length > 0 && (
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <AlertCircle className="size-4 text-amber-500" />
            Exceptions
            <span className="text-xs font-normal text-muted-foreground">
              queued jobs needing a decision
            </span>
          </div>
          <ul className="space-y-1.5">
            {board.exceptions.map((ex) => (
              <li key={ex.id}>
                <button
                  type="button"
                  onClick={() => setSelectedRequestId(ex.id)}
                  className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-medium">{ex.referenceNumber}</span>
                  <span className="text-muted-foreground">{ex.issueType}</span>
                  <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-px text-[11px] font-medium text-amber-700">
                    {ex.autoDispatchOutcome.replace("queued_", "").replace("_", " ")}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatDayLabel(ex.createdAt.slice(0, 10))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
```

- [ ] **Step 8: Run to pass.**
```bash
npx vitest run src/lib/admin/dispatch-exceptions-queries.test.ts
```
Expected: green. (No board-component test — no jsdom/RTL.)

- [ ] **Step 9: Run the full gate.**
```bash
npx tsc --noEmit
npx eslint src/lib/admin/dispatch-exceptions-queries.ts src/lib/admin/dispatch-exceptions-queries.test.ts "src/app/api/admin/dispatch/route.ts" src/hooks/use-dispatch-board.ts "src/app/admin/(dashboard)/dispatch/page.tsx"
```

- [ ] **Step 10: Commit.**
```bash
git add src/lib/admin/dispatch-exceptions-queries.ts src/lib/admin/dispatch-exceptions-queries.test.ts "src/app/api/admin/dispatch/route.ts" src/hooks/use-dispatch-board.ts "src/app/admin/(dashboard)/dispatch/page.tsx"
git commit -m "$(cat <<'EOF'
feat(dispatch): exceptions rail — day-independent queued-jobs view on the board

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: signals.ts A — chain-aware travel origin + recency window

The travel origin becomes the tech's same-business-day predecessor job's coords (when one exists whose `arrival_window_start` is before the scored job's window start) instead of the GPS/home anchor. Recency: skill uses a `count(*) FILTER` pair (all-time gates `skillMatched`, 180-day windowed `skillJobsCompletedRecent` drives depth); rating + conversion aggregates take a 180-day window. `skillJobsCompletedRecent` threads through the merge loop into `DispatchSignals` and `scoreTechnician` (depth uses recent, gate uses all-time).

**Files:**
- Modify: `src/lib/ai/dispatch/signals.ts` (predecessor query for the travel anchor; recency windows; new `skillJobsCompletedRecent`)
- Modify: `src/lib/ai/dispatch/score.ts` (`DispatchSignals.tech.skillJobsCompletedRecent`; depth uses recent, gate uses all-time)
- Modify: `src/lib/ai/dispatch/signals.test.ts` (recency + chain assertions)
- Modify: `src/lib/ai/dispatch/score.test.ts` (depth-from-recent while gate-from-all-time)

**Interfaces:**
- Consumes: `serviceRequests`, `customerLocations`, `users`, `reviewRequests`, `estimates`.
- Produces: `TechSignalRow.skillJobsCompletedRecent: number`; `DispatchSignals.tech.skillJobsCompletedRecent: number`; `scoreTechnician` uses `skillJobsCompletedRecent` for depth, `skillJobsCompleted` for `skillMatched`.

- [ ] **Step 1: Write the failing tests.**
  (a) In `src/lib/ai/dispatch/score.test.ts`, add to the `scoreTechnician` describe:
```ts
  it('skill depth uses the recency-windowed count; the gate uses all-time', () => {
    // All-time count 8 keeps skillMatched true, but recent depth 0 → skill term is 0.
    const r = scoreTechnician(
      signals('t1', { skillJobsCompleted: 8, skillJobsCompletedRecent: 0, avgRating: null, sameDayJobCount: 0 }),
    );
    expect(r.skillMatched).toBe(true); // gate = all-time
    // Skill depth term contributes 0 (recent=0): score == quality+load only.
    expect(r.score).toBeCloseTo((3.5 / 5) * 0.2 + 0.15, 5);
  });
```
  and update the `signals()` factory in that file to default `skillJobsCompletedRecent: 0` (add the key to the `tech` object).
  (b) In `src/lib/ai/dispatch/signals.test.ts`, update the two "defaulted row" / "interprets aggregated rows" expectations to include `skillJobsCompletedRecent`. For the defaulted row, add `skillJobsCompletedRecent: 0` to both expected objects. For the "interprets aggregated rows" test, change the skill mock row to carry both counts and assert both:
```ts
      [{ techId: 't1', n: 7, nRecent: 3 }], // skill (all-time 7, recent 3)
```
  and in that test's expected object add `skillJobsCompletedRecent: 3` (and keep `skillJobsCompleted: 7`).

- [ ] **Step 2: Run to see them fail.**
```bash
npx vitest run src/lib/ai/dispatch/score.test.ts src/lib/ai/dispatch/signals.test.ts
```
Expected failures: score — `skillJobsCompletedRecent` unknown on the tech type; signals — the defaulted rows lack `skillJobsCompletedRecent`, and the skill row shape mismatch.

- [ ] **Step 3a: Add `skillJobsCompletedRecent` to the score types + depth.** In `src/lib/ai/dispatch/score.ts`:
  1. In `DispatchSignals.tech`, after `skillJobsCompleted`, add:
```ts
    /** Same-category completed jobs within the recency window (180d). Drives skill
     * DEPTH; the all-time skillJobsCompleted still gates skillMatched so a proven
     * tech isn't locked out by a quiet quarter. */
    readonly skillJobsCompletedRecent: number;
```
  2. In `scoreTechnician`, change the depth line (:90) to use recent, keep the gate on all-time:
```ts
  const skillMatched = tech.skillJobsCompleted > 0;

  const skillDepth =
    Math.min(tech.skillJobsCompletedRecent, SKILL_DEPTH_CAP) / SKILL_DEPTH_CAP;
```

- [ ] **Step 3b: Compute both counts + recency windows + chain origin in signals.ts.** In `src/lib/ai/dispatch/signals.ts`:
  1. Add `skillJobsCompletedRecent` to `TechSignalRow` (after `skillJobsCompleted`... note the current interface starts with `skillJobsCompleted`; if absent add it) — the current default map (:103) sets `skillJobsCompleted: 0`; add `skillJobsCompletedRecent: 0` next to it, and add the field to `TechSignalRow`:
```ts
export interface TechSignalRow {
  readonly skillJobsCompleted: number;
  readonly skillJobsCompletedRecent: number;
  readonly avgRating: number | null;
  // ...rest unchanged
```
  2. Add a recency cutoff constant near the top (after the imports):
```ts
// ~180-day window approximating the 90-day half-life intent (a simple cutoff;
// per-row exponential decay is deliberately not built). Skill DEPTH, rating, and
// conversion use it; the skill GATE stays all-time.
const RECENCY_WINDOW_DAYS = 180;
```
  3. In `loadDispatchSignals`, compute the cutoff once (after `const { start: dayStart, end: dayEnd } = businessDayUtcRange(isoDay);`):
```ts
  const recencyCutoff = new Date(
    Date.now() - RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
```
  4. Change the SKILL query (:134) to return BOTH counts via a `FILTER` pair (gate = all-time `n`, depth = windowed `nRecent`). Replace its `.select({ techId, n: count() })` with:
```ts
          .select({
            techId: serviceRequests.assignedTo,
            n: count(),
            nRecent: sql<number>`count(*) FILTER (WHERE ${serviceRequests.completedAt} >= ${recencyCutoff})`,
          })
```
  (`serviceRequests.completedAt` exists — `schema.ts:601`, `timestamp("completed_at", { withTimezone: true })` — so use it directly; the skill query already filters `status = "completed"`, so the FILTER windows recent completions.)
  5. Add a 180-day window to the RATING query (:152) — add `gte(serviceRequests.updatedAt, recencyCutoff)` into its `and(...)`. Add to the CONVERSION query (:192) — add `gte(estimates.createdAt, recencyCutoff)` into its `where`'s conditions (wrap the existing `inArray(...)` in an `and(...)`). Leave the revenue query all-time (it's a reason only, not a weighted term).
  6. In the merge loop for `skillRows` (:234), set both counts:
```ts
  for (const r of skillRows) {
    if (r.techId && result.has(r.techId)) {
      result.set(r.techId, {
        ...result.get(r.techId)!,
        skillJobsCompleted: Number(r.n),
        skillJobsCompletedRecent: Number(r.nRecent),
      });
    }
  }
```
  7. **Chain-aware origin.** In `loadTravelSignals`, before computing haversine from anchors, look up each tech's predecessor job coords for the scored job's same business day, and use them as the origin when present. Add a helper `loadChainOrigins` and call it. The scored job's window start is read inside the query by joining on the passed `requestId`. Insert after `const jobCoords = await loadJobCoords(...)` and before `const anchors = ...`:
```ts
  // Chain-aware origin: a tech's true origin for a job later today is their
  // previous scheduled job's location, not their GPS/home anchor. One batched
  // DISTINCT ON query finds, per tech, their latest same-business-day non-cancelled
  // assigned job whose window starts before THIS job's window (read inside the
  // query via requestId) and has cached coords. A windowless scored job → no chain.
  const chainOrigins = await loadChainOrigins(
    organizationId,
    requestId,
    technicianIds,
  );
```
  and change the per-tech loop that fills haversine so a chain origin overrides the anchor:
```ts
  const anchors = await loadTechAnchors(organizationId, technicianIds);
  for (const id of technicianIds) {
    const origin = chainOrigins.get(id) ?? anchors.get(id);
    if (origin) {
      out.set(id, {
        km: haversineKm(origin.lat, origin.lon, jobCoords.lat, jobCoords.lon),
        minutes: null,
      });
    }
  }
```
  and change the routing block to price whichever origins exist (chain OR anchor). Replace `const withAnchor = technicianIds.filter((id) => anchors.get(id));` with:
```ts
    const originOf = (id: string) => chainOrigins.get(id) ?? anchors.get(id);
    const withAnchor = technicianIds.filter((id) => originOf(id));
    if (withAnchor.length > 0) {
      const origins = withAnchor.map((id) => {
        const a = originOf(id)!;
        return { lat: a.lat, lon: a.lon };
      });
```
  Then add the `loadChainOrigins` helper at the bottom of the file:
```ts
/** Per-tech predecessor origin: the latest same-business-day non-cancelled
 * assigned job (with cached coords) whose arrival window starts BEFORE the scored
 * job's window start. DISTINCT ON tech (no N+1). The scored job's window start is
 * read inside the query by joining on requestId; a NULL window → no chain (skip
 * every tech). Excludes the scored request itself. */
async function loadChainOrigins(
  organizationId: string,
  requestId: string,
  technicianIds: readonly string[],
): Promise<Map<string, { readonly lat: number; readonly lon: number }>> {
  const out = new Map<string, { readonly lat: number; readonly lon: number }>();
  if (technicianIds.length === 0) return out;
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (pred.assigned_to)
      pred.assigned_to AS tech_id,
      cl.latitude AS lat,
      cl.longitude AS lon
    FROM service_requests scored
    JOIN service_requests pred
      ON pred.organization_id = ${organizationId}
      AND pred.assigned_to = ANY(${technicianIds as string[]})
      AND pred.id <> scored.id
      AND pred.status <> 'cancelled'
      AND pred.arrival_window_start IS NOT NULL
      AND pred.arrival_window_start < scored.arrival_window_start
      AND date_trunc('day', pred.arrival_window_start) = date_trunc('day', scored.arrival_window_start)
    JOIN customer_locations cl
      ON cl.id = pred.location_id
      AND cl.organization_id = ${organizationId}
      AND cl.latitude IS NOT NULL
      AND cl.longitude IS NOT NULL
    WHERE scored.organization_id = ${organizationId}
      AND scored.id = ${requestId}
      AND scored.arrival_window_start IS NOT NULL
    ORDER BY pred.assigned_to, pred.arrival_window_start DESC
  `);
  const list = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown[]);
  for (const r of list as Array<{ tech_id: string; lat: number; lon: number }>) {
    if (r.tech_id && r.lat != null && r.lon != null) {
      out.set(r.tech_id, { lat: Number(r.lat), lon: Number(r.lon) });
    }
  }
  return out;
}
```
  8. Thread `skillJobsCompletedRecent` into the scorer input in `rankedTechnicianOrder` (`src/lib/admin/scheduling-queries.ts` :1139) — in the `candidates` map's `tech` object, add `skillJobsCompletedRecent: s.skillJobsCompletedRecent,` next to `skillJobsCompleted`. Also update the mocked `loadDispatchSignals` in `scheduling-queries.test.ts` (:162) to include `skillJobsCompletedRecent: 0` in the returned map objects.

- [ ] **Step 4: Run to pass.**
```bash
npx vitest run src/lib/ai/dispatch/score.test.ts src/lib/ai/dispatch/signals.test.ts src/lib/admin/scheduling-queries.test.ts
```
Expected: green. Note: `loadChainOrigins` uses `db.execute(sql...)`, but the signals test's mocked db only provides `select`. Add an `execute` mock to the `db` object RETURNED by the `vi.mock("@/lib/db", ...)` factory (NOT the `vi.hoisted` block) — a `vi.fn()` created inline in the factory so it defaults to `{ rows: [] }` (no predecessors → haversine falls back to anchors, preserving every existing travel-term assertion) and stays per-test overridable via `dbMod.db.execute`. Change the factory (:19-23) from:
```ts
vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
  },
}));
```
  to:
```ts
vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    // Chain-origin lookup (loadChainOrigins) uses db.execute. Default: no
    // predecessors, so travel falls back to anchors and existing assertions hold.
    // A test may override with dbMod.db.execute.mockResolvedValueOnce(...).
    execute: vi.fn(async () => ({ rows: [] as unknown[] })),
  },
}));
```
  Then add a focused chain test:
```ts
    it('uses a predecessor job origin over the anchor when one exists', async () => {
      // db.execute returns a predecessor near the job → chain km ~0.
      const dbMod = await import('@/lib/db');
      (dbMod.db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ tech_id: 't1', lat: 36.33, lon: -82.38 }],
      });
      selectQueue.push(
        [], [], [], [], [],
        [{ lat: 36.33, lon: -82.38 }],          // job coords == predecessor
        [{ id: 't1', lat: 10.0, lon: 10.0 }],   // far home base (should be ignored)
      );
      const m = await loadDispatchSignals(
        'org', ['t1'], { jobType: 'no_cool', systemType: null }, '2026-06-24', 'req-1',
      );
      expect(m.get('t1')!.travelKm!).toBeLessThan(1); // predecessor origin won
    });
```

- [ ] **Step 5: Run the full gate.**
```bash
npx tsc --noEmit
npx eslint src/lib/ai/dispatch/signals.ts src/lib/ai/dispatch/score.ts src/lib/ai/dispatch/signals.test.ts src/lib/ai/dispatch/score.test.ts src/lib/admin/scheduling-queries.ts src/lib/admin/scheduling-queries.test.ts
```

- [ ] **Step 6: Commit.**
```bash
git add src/lib/ai/dispatch/signals.ts src/lib/ai/dispatch/score.ts src/lib/ai/dispatch/signals.test.ts src/lib/ai/dispatch/score.test.ts src/lib/admin/scheduling-queries.ts src/lib/admin/scheduling-queries.test.ts
git commit -m "$(cat <<'EOF'
feat(dispatch): chain-aware travel origin + 180-day recency-windowed signals

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: score/signals B — duration-fit down-rank

New pure helper `sumAvailabilityMinutes(slots)`; signals gains `bookedMinutes` (grouped SUM of `estimated_duration_minutes`, 60-default when null, same-day non-cancelled assigned jobs), `dayMinutes` per tech, and `thisJobEstimate`; `scoreTechnician` applies a fixed −0.1 penalty + reason "day likely full" when `bookedMinutes + thisJobEstimate > dayMinutes`. Down-rank only.

**Files:**
- Modify: `src/lib/ai/dispatch/score.ts` (new `sumAvailabilityMinutes`; penalty in `scoreTechnician`; new tech fields)
- Modify: `src/lib/ai/dispatch/signals.ts` (booked-minutes SUM; day-minutes per tech; this-job estimate)
- Modify: `src/lib/ai/dispatch/score.test.ts` (helper + penalty tests)
- Modify: `src/lib/ai/dispatch/signals.test.ts` (booked/day/estimate defaults)

**Interfaces:**
- Consumes: `serviceRequests` (`estimatedDurationMinutes`), `technicianAvailability`; the `DEFAULT_BUSINESS_DAY` span (8:00–20:00 → 720 min).
- Produces: `sumAvailabilityMinutes(slots: readonly { startMinute: number; endMinute: number }[]): number`; `DispatchSignals.tech.bookedMinutes: number`, `.dayMinutes: number`, `.thisJobEstimate: number`; a −0.1 penalty in `scoreTechnician`.

- [ ] **Step 1: Write the failing tests.**
  (a) In `src/lib/ai/dispatch/score.test.ts`, add the helper import and tests:
```ts
import { sumAvailabilityMinutes } from './score';

describe('sumAvailabilityMinutes', () => {
  it('sums slot spans', () => {
    expect(
      sumAvailabilityMinutes([
        { startMinute: 480, endMinute: 720 }, // 240
        { startMinute: 780, endMinute: 1020 }, // 240
      ]),
    ).toBe(480);
  });
  it('falls back to 720 (8:00-20:00) for empty slots', () => {
    expect(sumAvailabilityMinutes([])).toBe(720);
  });
});
```
  and a penalty test in the `scoreTechnician` describe:
```ts
  it('down-ranks a tech whose day likely will not fit the job (-0.1 + reason)', () => {
    const roomy = scoreTechnician(
      signals('t1', { skillJobsCompleted: 5, skillJobsCompletedRecent: 5, bookedMinutes: 60, dayMinutes: 720, thisJobEstimate: 120 }),
    );
    const packed = scoreTechnician(
      signals('t2', { skillJobsCompleted: 5, skillJobsCompletedRecent: 5, bookedMinutes: 700, dayMinutes: 720, thisJobEstimate: 120 }),
    );
    expect(packed.score).toBeCloseTo(roomy.score - 0.1, 5);
    expect(packed.reasons).toContain('day likely full');
    expect(roomy.reasons).not.toContain('day likely full');
  });
```
  Update the `signals()` factory in `score.test.ts` to default `bookedMinutes: 0, dayMinutes: 720, thisJobEstimate: 0` in the `tech` object.
  (b) In `src/lib/ai/dispatch/signals.test.ts`, add `bookedMinutes: 0`, `dayMinutes: 720`, `thisJobEstimate: 0` to the two expected defaulted rows and the "interprets aggregated rows" expected object (the aggregate mocks will need matching pushes — see Step 3).

- [ ] **Step 2: Run to see them fail.**
```bash
npx vitest run src/lib/ai/dispatch/score.test.ts src/lib/ai/dispatch/signals.test.ts
```
Expected failures: `sumAvailabilityMinutes` not exported; tech type lacks `bookedMinutes`/`dayMinutes`/`thisJobEstimate`; defaulted rows mismatch.

- [ ] **Step 3a: Implement `sumAvailabilityMinutes` + the penalty in score.ts.**
  1. Add the helper + constant near the top of `src/lib/ai/dispatch/score.ts`:
```ts
// Empty availability → the same bounded default the coverage check uses
// (Mon–Fri 8:00–20:00 = 720 min). Kept in sync with availability-coverage.ts's
// DEFAULT_BUSINESS_DAY (module-local there; duplicated here as a constant to avoid
// importing a server-tz helper into the pure scorer).
const DEFAULT_DAY_MINUTES = 720;

/** Total working minutes across a tech's weekday slots (sum of endMinute −
 * startMinute). Empty → DEFAULT_DAY_MINUTES. Pure. */
export function sumAvailabilityMinutes(
  slots: readonly { readonly startMinute: number; readonly endMinute: number }[],
): number {
  if (slots.length === 0) return DEFAULT_DAY_MINUTES;
  return slots.reduce((sum, s) => sum + (s.endMinute - s.startMinute), 0);
}

// Fixed down-rank when the tech's booked minutes + this job likely overflow their
// working day. Down-rank ONLY — the hard gate stays placeAndAssignRequest's
// conflict/availability check.
const DURATION_FIT_PENALTY = 0.1;
```
  2. Add the three fields to `DispatchSignals.tech` (after `skillJobsCompletedRecent`):
```ts
    /** Σ estimated duration (min) of same-day non-cancelled assigned jobs. */
    readonly bookedMinutes: number;
    /** Total working minutes in the tech's day (sumAvailabilityMinutes). */
    readonly dayMinutes: number;
    /** Estimated on-site minutes for THIS job. */
    readonly thisJobEstimate: number;
```
  3. In `scoreTechnician`, after the travel overlay computes `score` and before building `reasons` (or right after the `reasons` array is created), apply the penalty:
```ts
  // Duration-fit down-rank: if the booked day plus this job overflows the working
  // window, the tech probably can't fit it — nudge them down (not a hard gate).
  let dayLikelyFull = false;
  if (tech.bookedMinutes + tech.thisJobEstimate > tech.dayMinutes) {
    score = Math.max(0, score - DURATION_FIT_PENALTY);
    dayLikelyFull = true;
  }
```
  and push the reason (inside the reasons assembly, before the `return`):
```ts
  if (dayLikelyFull) reasons.push("day likely full");
```
  Ensure `score` is a `let` (it already is) and the penalty is applied after all travel-regime branches set `score`.

- [ ] **Step 3b: Compute booked/day/estimate in signals.ts.** In `src/lib/ai/dispatch/signals.ts`:
  1. Import the helper + the availability table: at the top add `import { sumAvailabilityMinutes } from "./score";` and add `technicianAvailability` to the schema import list.
  2. Add the three fields to `TechSignalRow` (with the defaults in the default map = `bookedMinutes: 0, dayMinutes: <default>, thisJobEstimate: 0`). Compute `thisJobEstimate` once and the per-tech day-minutes / booked-minutes via two more queries. After the existing `Promise.all([...])` add:
```ts
  // Duration-fit inputs: this job's estimate, each tech's booked same-day minutes,
  // and each tech's total working minutes for the weekday.
  const [estimateRow, bookedRows, availabilityRows] = await Promise.all([
    requestId
      ? db
          .select({ minutes: serviceRequests.estimatedDurationMinutes })
          .from(serviceRequests)
          .where(
            withTenant(
              serviceRequests,
              organizationId,
              eq(serviceRequests.id, requestId),
            ),
          )
          .limit(1)
      : Promise.resolve([] as { minutes: number | null }[]),
    db
      .select({
        techId: serviceRequests.assignedTo,
        booked: sql<number>`COALESCE(SUM(COALESCE(${serviceRequests.estimatedDurationMinutes}, 60)), 0)`,
      })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          and(
            inArray(serviceRequests.assignedTo, ids),
            inArray(serviceRequests.status, [...SAME_DAY_LOAD_STATUSES]),
            gte(serviceRequests.arrivalWindowStart, dayStart),
            lt(serviceRequests.arrivalWindowStart, dayEnd),
          )!,
        ),
      )
      .groupBy(serviceRequests.assignedTo),
    db
      .select({
        techId: technicianAvailability.technicianId,
        startMinute: technicianAvailability.startMinute,
        endMinute: technicianAvailability.endMinute,
        dayOfWeek: technicianAvailability.dayOfWeek,
      })
      .from(technicianAvailability)
      .where(
        withTenant(
          technicianAvailability,
          organizationId,
          inArray(technicianAvailability.technicianId, ids),
        ),
      ),
  ]);

  const thisJobEstimate = Number(estimateRow[0]?.minutes ?? 0);
  // Weekday of the scored day (0=Sun..6=Sat) from the business-day range start.
  const weekday = dayStart.getUTCDay();
  const slotsByTech = new Map<string, { startMinute: number; endMinute: number }[]>();
  for (const s of availabilityRows) {
    if (s.dayOfWeek !== weekday) continue;
    const arr = slotsByTech.get(s.techId) ?? [];
    arr.push({ startMinute: s.startMinute, endMinute: s.endMinute });
    slotsByTech.set(s.techId, arr);
  }
  const bookedByTech = new Map(
    bookedRows.map((r) => [r.techId, Number(r.booked)]),
  );
  for (const id of technicianIds) {
    result.set(id, {
      ...result.get(id)!,
      bookedMinutes: bookedByTech.get(id) ?? 0,
      dayMinutes: sumAvailabilityMinutes(slotsByTech.get(id) ?? []),
      thisJobEstimate,
    });
  }
```
  (Note: `weekday` from `dayStart.getUTCDay()` — `dayStart` is the business-day range start in UTC; because business midnight maps to 04:00/05:00Z of the SAME date, its UTC weekday equals the business weekday. This matches how `businessDayUtcRange` anchors the day.)
  3. Thread the three fields into the scorer input in `rankedTechnicianOrder` (`src/lib/admin/scheduling-queries.ts` :1139) — in the `tech` object add `bookedMinutes: s.bookedMinutes, dayMinutes: s.dayMinutes, thisJobEstimate: s.thisJobEstimate,`. Update the mocked `loadDispatchSignals` in `scheduling-queries.test.ts` to include `bookedMinutes: 0, dayMinutes: 720, thisJobEstimate: 0` in its returned objects.

- [ ] **Step 4: Update signals.test.ts mock pushes.** The three new queries run whenever `technicianIds.length > 0`. In `signals.test.ts`, the existing tests push exactly the aggregate-count arrays; add three more empty results per `loadDispatchSignals` call: after the existing 5 aggregate pushes (and any travel pushes), the new order is estimate-row, booked-rows, availability-rows. Since these run in a second `Promise.all` AFTER the first, the mock `selectQueue.shift()` will feed them in order. Update each test to append `[], [], []` (estimate/booked/availability → all empty) at the end of its `selectQueue.push(...)`. For the "interprets aggregated rows" test, to exercise a non-default, optionally push `[{ minutes: 90 }]`, `[{ techId: 't1', booked: 120 }]`, `[{ techId: 't1', startMinute: 480, endMinute: 1020, dayOfWeek: 3 }]` and assert `bookedMinutes: 120`, `thisJobEstimate: 90`, `dayMinutes: 540`. The isoDay `'2026-06-24'` is a Wednesday → business weekday 3, so `dayOfWeek: 3` makes the slot count (a non-matching weekday would be filtered out and `dayMinutes` would fall back to the 720 default). Keep the simplest tests pushing `[], [], []` for the defaults.

- [ ] **Step 5: Run to pass.**
```bash
npx vitest run src/lib/ai/dispatch/score.test.ts src/lib/ai/dispatch/signals.test.ts src/lib/admin/scheduling-queries.test.ts
```
Expected: green.

- [ ] **Step 6: Run the full gate.**
```bash
npx tsc --noEmit
npx eslint src/lib/ai/dispatch/score.ts src/lib/ai/dispatch/signals.ts src/lib/ai/dispatch/score.test.ts src/lib/ai/dispatch/signals.test.ts src/lib/admin/scheduling-queries.ts src/lib/admin/scheduling-queries.test.ts
```

- [ ] **Step 7: Commit.**
```bash
git add src/lib/ai/dispatch/score.ts src/lib/ai/dispatch/signals.ts src/lib/ai/dispatch/score.test.ts src/lib/ai/dispatch/signals.test.ts src/lib/admin/scheduling-queries.ts src/lib/admin/scheduling-queries.test.ts
git commit -m "$(cat <<'EOF'
feat(dispatch): duration-fit down-rank (-0.1 when the day likely won't fit)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Docs + final full-suite gate

Mark items 1–9 ✅ in `docs/DISPATCH.md` with one-line "what shipped" notes (move nothing else), run the FULL gate, fix anything the tasks broke, commit.

**Files:**
- Modify: `docs/DISPATCH.md` (the `## Sequenced plan` items 1–9)

**Interfaces:**
- Consumes: everything shipped in Tasks 1–9.
- Produces: updated docs; a green full suite.

- [ ] **Step 0: Establish the full-suite baseline BEFORE any Task-10 edits.** Record the current pass/fail count so a regression is attributable. Either run the full suite on the pre-work tree first (`git stash` any in-progress work, `npx vitest run`, note the "N passed / M failed" line, then `git stash pop`), OR use the last known CI baseline: **3,949 passed as of 2026-07-20** (plus the known ~7 DB/server-dependent suites that fail at import because vitest skips `.env.local` — pre-existing, NOT regressions). Any NEW failure at Step 2 beyond that baseline traces to a Task 1–9 change and must be fixed here (Step 3) before committing.

- [ ] **Step 1: Update `docs/DISPATCH.md`.** In the `## Sequenced plan` section, prefix each shipped item with ✅ and append a one-line "shipped:" note. Edit items 1–9 as follows (keep all other prose intact; move nothing):
  - Item 1 heading → `1. ✅ **Override telemetry** — …` and append: `_Shipped: 0041 columns overridden_technician_id/by_user_id/at; stampDispatchOverride called from assign/reassign/reschedule with session.userId; best-effort last-write-wins._`
  - Item 2 → `2. ✅ **Shadow mode** — …` append: `_Shipped: 0041 is_shadow column; autopilot-off orgs record the would-be decision (haversine-only, no service_requests writes, quality gate skipped); recordDispatchDecision gained isShadow._`
  - Item 3 → `3. ✅ **Outcome rollup + canary** — …` append: `_Shipped: getDispatchOutcomeRollup (real/shadow split); Operations "Dispatch health" card; weekly /api/cron/dispatch-digest collapse alert (this-week < 50% of trailing-28d, ≥20 each) via dispatch_alert_phone, per-org try/catch._`
  - Item 4 → `4. ✅ **Register the orphaned delay-sweep cron** — …` append: `_Shipped: vercel.json now registers /api/cron/delay-sweep (*/15) and /api/cron/dispatch-digest (weekly Mon)._`
  - Item 5 → `5. ✅ **"Why this tech?" decision panel** — …` append: `_Shipped: GET /api/admin/requests/[id]/decision (getDispatchDecisionForRequest resolves candidate names via one inArray); collapsible "Dispatch decision" section in RequestDetailSheet (shadow labeled "preview"); travelKm/travelMinutes added to the client type._`
  - Item 6 → `6. ✅ **Exceptions rail** — …` append: `_Shipped: day-independent getDispatchExceptions (unassigned + queued_* + non-terminal, oldest first, cap 20) on the dispatch board payload; "Exceptions" section opens the existing sheet._`
  - Item 7 → `7. ✅ **Chain-aware travel origin** — …` append: `_Shipped: DISTINCT ON predecessor query (same-business-day, window before the scored job, cached coords) overrides the GPS/home anchor; windowless scored job skips chain._`
  - Item 8 → `8. ✅ **Duration-fit down-rank** — …` append: `_Shipped: sumAvailabilityMinutes helper; signals gained bookedMinutes/dayMinutes/thisJobEstimate; scoreTechnician applies −0.1 + "day likely full" when the day overflows. Down-rank only._`
  - Item 9 → `9. ✅ **Recency-windowed signals** — …` append: `_Shipped: 180-day window on skill DEPTH (skillJobsCompletedRecent via count(*) FILTER), rating, and conversion; the skill GATE stays all-time._`

- [ ] **Step 2: Run the FULL gate.**
```bash
npx tsc --noEmit
npx eslint src
npx vitest run
```
Expected: 0 tsc errors, 0 eslint problems, full suite green. (Baseline note: a handful of DB/server-dependent suites fail at import under vitest because `.env.local` is skipped — those are pre-existing and NOT regressions. Compare against the Step 0 baseline (3,949 passed as of 2026-07-20, plus the ~7 known env-skipped import failures); confirm the count/names match. Any NEW failure beyond that baseline traces to a Task 1–9 change and must be fixed here before committing.)

- [ ] **Step 3: Fix any breakage** the tasks introduced (type errors, lint, newly-red tests). Re-run the full gate until green.

- [ ] **Step 4: Commit.**
```bash
git add docs/DISPATCH.md
git commit -m "$(cat <<'EOF'
docs(dispatch): mark sequenced-plan items 1-9 shipped

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```
