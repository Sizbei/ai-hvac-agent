# Probook-style AI Auto-Dispatch (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing first-fit `autoAssignBookedRequest` into a deterministic, skill-gated, scored ranker so a freshly-booked request is auto-assigned to the *best qualified* technician that fits — not just the first calendar-fit one.

**Architecture:** A pure, no-IO scoring+ranking module (`src/lib/ai/dispatch/score.ts`) holds all the decision logic and gets exhaustive unit tests. A thin DB loader (`src/lib/ai/dispatch/signals.ts`) gathers per-tech signals. The orchestrator (`autoAssignBookedRequest`) reads an org opt-in flag, and when enabled, loads signals → ranks (pure) → iterates the ranked list through the unchanged atomic `placeAndAssignRequest`, then marks the request `auto_assigned`. When the flag is off (default), behavior is byte-for-byte today's first-fit. A board badge and a settings toggle complete it.

**Tech Stack:** TypeScript, Next.js 16, Drizzle ORM on Neon (neon-http — no transactions), Vitest, Zod, shadcn/ui (Switch/Card).

**Spec:** `docs/superpowers/specs/2026-06-24-probook-ai-dispatch-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/lib/db/schema.ts` | Add `serviceRequests.autoAssigned` + `organizationSettings.autoDispatchEnabled` columns | Modify |
| `drizzle/0021_*.sql` + `drizzle/meta/*` | Migration for the two columns | Create (via drizzle-kit) |
| `src/lib/ai/dispatch/score.ts` | Pure scoring + ranking decision logic (no IO) | Create |
| `src/lib/ai/dispatch/score.test.ts` | Exhaustive unit tests for scoring/ranking | Create |
| `src/lib/ai/dispatch/signals.ts` | DB loader: per-tech skill/rating/load signals | Create |
| `src/lib/ai/dispatch/signals.test.ts` | Row-interpretation + default tests (Proxy harness) | Create |
| `src/lib/admin/scheduling-queries.ts` | Upgrade `autoAssignBookedRequest`; add 3 private helpers | Modify |
| `src/lib/admin/scheduling-queries.test.ts` | Orchestrator branch + markAutoAssigned test | Create (or append) |
| `src/lib/admin/org-config-types.ts` | `autoDispatchEnabled` in zod schema + `OrgConfig` + default | Modify |
| `src/lib/admin/org-config-queries.ts` | Read + write `autoDispatchEnabled` | Modify |
| `src/components/admin/settings/dispatch-panel.tsx` | Auto-dispatch toggle UI | Create |
| `src/app/admin/(dashboard)/settings/page.tsx` | New "Dispatch" tab hosting the panel | Modify |
| `src/lib/admin/queries.ts` | Carry `autoAssigned` through the dispatch board select/row/mapper | Modify |
| `src/lib/admin/types.ts` | `autoAssigned` on `DashboardRequest` | Modify |
| `src/components/admin/dispatch/dispatch-column.tsx` | "Auto" badge on auto-assigned job cards | Modify |

**Key types (defined once, used everywhere):**

```typescript
// src/lib/ai/dispatch/score.ts
export interface DispatchSignals {
  readonly job: {
    readonly jobType: string | null;
    readonly systemType: string | null;
    readonly urgency: string;
  };
  readonly tech: {
    readonly technicianId: string;
    readonly skillJobsCompleted: number; // completed jobs whose jobType OR systemType matches (counted once)
    readonly avgRating: number | null;
    readonly sameDayJobCount: number;
  };
}
export interface RankedTech {
  readonly technicianId: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly skillMatched: boolean;
}
```

---

## Task 1: Schema columns + migration

**Files:**
- Modify: `src/lib/db/schema.ts` (serviceRequests ~line 479, organizationSettings ~line 910)
- Create: `drizzle/0021_*.sql` + `drizzle/meta/*` (via drizzle-kit)

- [ ] **Step 1: Add `autoAssigned` to the `serviceRequests` table**

In `src/lib/db/schema.ts`, find the `serviceRequests` column block. Immediately AFTER the `status` column line:

```typescript
    status: requestStatusEnum("status").notNull().default("pending"),
```

add:

```typescript
    // True when the system (not a human dispatcher) assigned this request — set
    // by autoAssignBookedRequest on a successful auto-assign. Drives the board's
    // "Auto" badge. Default false: human/drag assignments stay unflagged.
    autoAssigned: boolean("auto_assigned").notNull().default(false),
```

(`boolean` is already imported in schema.ts — it is used by other tables. Do not add an import.)

- [ ] **Step 2: Add `autoDispatchEnabled` to the `organizationSettings` table**

In the `organizationSettings` table (`export const organizationSettings = pgTable("organization_settings", {`), add this column just before the closing `});` of the column object (after the onboarding/`aiModelId` fields, alongside the other operational levers):

```typescript
  // ── Auto-dispatch (Probook-style scored assignment) ──
  // OFF by default: when false, a freshly-booked request auto-assigns first-fit
  // (today's behavior). When true, autoAssignBookedRequest ranks technicians by
  // a deterministic skill/quality/load score and assigns the best one that fits.
  autoDispatchEnabled: boolean("auto_dispatch_enabled").notNull().default(false),
```

- [ ] **Step 3: Generate the migration**

The drizzle meta snapshot was resynced in 0020, so `drizzle-kit generate` now produces a clean diff.

Run: `npx drizzle-kit generate`
Expected: a new `drizzle/0021_<name>.sql` plus an updated `drizzle/meta/0021_snapshot.json` and `_journal.json`. The SQL must contain EXACTLY these two statements (nothing else — if it proposes other columns, STOP: the snapshot drifted and must be investigated, do not apply):

```sql
ALTER TABLE "service_requests" ADD COLUMN "auto_assigned" boolean DEFAULT false NOT NULL;
ALTER TABLE "organization_settings" ADD COLUMN "auto_dispatch_enabled" boolean DEFAULT false NOT NULL;
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors (the new columns are now part of the inferred row types).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema.ts drizzle/0021_*.sql drizzle/meta/
git commit -m "feat(dispatch): add auto_assigned + auto_dispatch_enabled columns"
```

> NOTE: The migration is NOT run against the DB here — deploys run `npm run db:migrate` separately (see the project's migration convention). The columns have safe `DEFAULT false`, so the app code in later tasks works against both pre- and post-migration DBs only AFTER migrate runs; until then `auto_assigned`/`auto_dispatch_enabled` reads would 500. Apply the migration to the dev DB before manual testing: `npm run db:migrate`.

---

## Task 2: Pure scoring + ranking engine (the load-bearing logic)

**Files:**
- Create: `src/lib/ai/dispatch/score.ts`
- Test: `src/lib/ai/dispatch/score.test.ts`

This module is pure (no DB, no imports beyond types). All assignment logic lives here so it is exhaustively testable in isolation.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/ai/dispatch/score.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { scoreTechnician, rankTechnicians, type DispatchSignals } from './score';

const job = { jobType: 'no_cool', systemType: 'central_ac', urgency: 'standard' } as const;

function signals(
  technicianId: string,
  over: Partial<DispatchSignals['tech']> = {},
): DispatchSignals {
  return {
    job,
    tech: {
      technicianId,
      skillJobsCompleted: 0,
      avgRating: null,
      sameDayJobCount: 0,
      ...over,
    },
  };
}

describe('scoreTechnician', () => {
  it('marks a tech with zero matching jobs as not skill-matched', () => {
    const r = scoreTechnician(signals('t1', { skillJobsCompleted: 0 }));
    expect(r.skillMatched).toBe(false);
    expect(r.reasons.some((x) => x.includes('no prior'))).toBe(true);
  });

  it('marks a tech with >=1 matching job as skill-matched', () => {
    const r = scoreTechnician(signals('t1', { skillJobsCompleted: 1 }));
    expect(r.skillMatched).toBe(true);
  });

  it('weights skill depth, quality, and load into [0,1]', () => {
    // Max signals: 10+ skill jobs, 5.0 rating, 0 load → 0.5 + 0.3 + 0.2 = 1.0
    const best = scoreTechnician(
      signals('t1', { skillJobsCompleted: 10, avgRating: 5, sameDayJobCount: 0 }),
    );
    expect(best.score).toBeCloseTo(1.0, 5);
    // Skill depth caps at 10 jobs.
    const capped = scoreTechnician(
      signals('t1', { skillJobsCompleted: 50, avgRating: 5, sameDayJobCount: 0 }),
    );
    expect(capped.score).toBeCloseTo(1.0, 5);
  });

  it('defaults a missing rating to 3.5/5 for the quality term', () => {
    // skill 0 (still scored), rating null → 3.5/5 * 0.3, load 0 → 0.2
    const r = scoreTechnician(
      signals('t1', { skillJobsCompleted: 0, avgRating: null, sameDayJobCount: 0 }),
    );
    expect(r.score).toBeCloseTo((3.5 / 5) * 0.3 + 0.2, 5);
  });

  it('penalizes same-day load, flooring at 6 jobs', () => {
    const light = scoreTechnician(signals('t1', { skillJobsCompleted: 10, avgRating: 5, sameDayJobCount: 0 }));
    const heavy = scoreTechnician(signals('t1', { skillJobsCompleted: 10, avgRating: 5, sameDayJobCount: 6 }));
    const overloaded = scoreTechnician(signals('t1', { skillJobsCompleted: 10, avgRating: 5, sameDayJobCount: 99 }));
    expect(heavy.score).toBeLessThan(light.score);
    expect(overloaded.score).toBeCloseTo(heavy.score, 5); // floored at 6
  });

  it('produces human-readable reasons', () => {
    const r = scoreTechnician(
      signals('t1', { skillJobsCompleted: 7, avgRating: 4.9, sameDayJobCount: 2 }),
    );
    expect(r.reasons).toContain('7 prior no_cool jobs');
    expect(r.reasons).toContain('4.9★');
    expect(r.reasons).toContain('2 jobs today');
  });
});

describe('rankTechnicians', () => {
  it('drops non-skill-matched techs and sorts the rest by score desc', () => {
    const ranked = rankTechnicians([
      signals('unqualified', { skillJobsCompleted: 0, avgRating: 5 }),
      signals('ok', { skillJobsCompleted: 2, avgRating: 4.0, sameDayJobCount: 3 }),
      signals('best', { skillJobsCompleted: 9, avgRating: 5.0, sameDayJobCount: 0 }),
    ]);
    expect(ranked.map((r) => r.technicianId)).toEqual(['best', 'ok']);
  });

  it('returns an empty array when no tech is skill-matched', () => {
    const ranked = rankTechnicians([
      signals('a', { skillJobsCompleted: 0 }),
      signals('b', { skillJobsCompleted: 0 }),
    ]);
    expect(ranked).toEqual([]);
  });

  it('breaks ties deterministically by technicianId', () => {
    const ranked = rankTechnicians([
      signals('zeta', { skillJobsCompleted: 5, avgRating: 4, sameDayJobCount: 1 }),
      signals('alpha', { skillJobsCompleted: 5, avgRating: 4, sameDayJobCount: 1 }),
    ]);
    expect(ranked.map((r) => r.technicianId)).toEqual(['alpha', 'zeta']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/ai/dispatch/score.test.ts`
Expected: FAIL — `Cannot find module './score'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ai/dispatch/score.ts`:

```typescript
/**
 * Pure, deterministic dispatch scoring. No IO, no LLM — an auto-assignment is a
 * money/ops decision that must be explainable, cheap, and hallucination-free.
 * All weights are constants (ML-tunable later). See the design spec.
 */

export interface DispatchSignals {
  readonly job: {
    readonly jobType: string | null;
    readonly systemType: string | null;
    readonly urgency: string;
  };
  readonly tech: {
    readonly technicianId: string;
    /** Completed jobs whose jobType OR systemType matches the incoming job (counted once). */
    readonly skillJobsCompleted: number;
    readonly avgRating: number | null;
    readonly sameDayJobCount: number;
  };
}

export interface RankedTech {
  readonly technicianId: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly skillMatched: boolean;
}

// Scoring weights (sum to 1.0).
const W_SKILL = 0.5;
const W_QUALITY = 0.3;
const W_LOAD = 0.2;

const SKILL_DEPTH_CAP = 10; // jobs beyond this don't increase skill depth
const LOAD_CAP = 6; // same-day jobs beyond this don't increase the load penalty
const DEFAULT_RATING = 3.5; // assumed quality for a tech with no ratings yet

/** A short label for the job's specialty, for human-readable reasons. */
function skillLabel(job: DispatchSignals['job']): string {
  return job.jobType ?? job.systemType ?? 'matching';
}

export function scoreTechnician(signals: DispatchSignals): RankedTech {
  const { job, tech } = signals;
  const skillMatched = tech.skillJobsCompleted > 0;

  const skillDepth = Math.min(tech.skillJobsCompleted, SKILL_DEPTH_CAP) / SKILL_DEPTH_CAP;
  const quality = (tech.avgRating ?? DEFAULT_RATING) / 5;
  const load = 1 - Math.min(tech.sameDayJobCount, LOAD_CAP) / LOAD_CAP;

  const score = skillDepth * W_SKILL + quality * W_QUALITY + load * W_LOAD;

  const reasons: string[] = [];
  reasons.push(
    skillMatched
      ? `${tech.skillJobsCompleted} prior ${skillLabel(job)} jobs`
      : `no prior ${skillLabel(job)} experience`,
  );
  if (tech.avgRating != null) reasons.push(`${tech.avgRating.toFixed(1)}★`);
  reasons.push(`${tech.sameDayJobCount} jobs today`);

  return { technicianId: tech.technicianId, score, reasons, skillMatched };
}

/**
 * Score every candidate, drop the non-skill-matched, and sort by score desc.
 * Ties break by technicianId (ascending) so the ordering is fully deterministic.
 */
export function rankTechnicians(candidates: readonly DispatchSignals[]): RankedTech[] {
  return candidates
    .map(scoreTechnician)
    .filter((r) => r.skillMatched)
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.technicianId.localeCompare(b.technicianId),
    );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ai/dispatch/score.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/dispatch/score.ts src/lib/ai/dispatch/score.test.ts
git commit -m "feat(dispatch): add pure scoring + ranking engine"
```

---

## Task 3: Signals loader (DB → per-tech signals)

**Files:**
- Create: `src/lib/ai/dispatch/signals.ts`
- Test: `src/lib/ai/dispatch/signals.test.ts`

Loads the three signals the scorer needs. neon-http aggregates run in the DB, so the loader interprets already-aggregated rows.

- [ ] **Step 1: Write the implementation**

Create `src/lib/ai/dispatch/signals.ts`:

```typescript
import { and, eq, or, gte, lt, inArray, avg, count, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests, reviewRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface DispatchJobAttrs {
  readonly jobType: string | null;
  readonly systemType: string | null;
}

/** The three raw signals the scorer consumes, per technician. */
export interface TechSignalRow {
  readonly skillJobsCompleted: number;
  readonly avgRating: number | null;
  readonly sameDayJobCount: number;
}

// Open statuses that count toward a tech's same-day load (everything not
// terminal and already placed on a day).
const SAME_DAY_LOAD_STATUSES = ["assigned", "scheduled", "in_progress", "on_hold"] as const;

type JobTypeValue = (typeof serviceRequests.jobType.enumValues)[number];
type SystemTypeValue = (typeof serviceRequests.systemType.enumValues)[number];

/**
 * Load dispatch signals for a set of technicians, scoped to one org.
 * Returns a Map keyed by technicianId; every requested tech is present (defaulted
 * to zeros / null) so the caller never has to null-check a missing tech.
 *
 * When the job has NO classification (both jobType and systemType null) there is
 * no skill signal to match on, so skillJobsCompleted stays 0 for everyone — the
 * scorer then matches nobody and the orchestrator degrades to the dispatcher.
 */
export async function loadDispatchSignals(
  organizationId: string,
  technicianIds: readonly string[],
  job: DispatchJobAttrs,
  isoDay: string,
): Promise<Map<string, TechSignalRow>> {
  const result = new Map<string, TechSignalRow>();
  for (const id of technicianIds) {
    result.set(id, { skillJobsCompleted: 0, avgRating: null, sameDayJobCount: 0 });
  }
  if (technicianIds.length === 0) return result;

  const ids = [...technicianIds];
  const dayStart = new Date(`${isoDay}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  // Skill predicate from whichever classification fields are present.
  const skillMatchers = [];
  if (job.jobType) skillMatchers.push(eq(serviceRequests.jobType, job.jobType as JobTypeValue));
  if (job.systemType) skillMatchers.push(eq(serviceRequests.systemType, job.systemType as SystemTypeValue));
  const skillPredicate = skillMatchers.length === 1 ? skillMatchers[0] : skillMatchers.length > 1 ? or(...skillMatchers) : null;

  const [skillRows, ratingRows, loadRows] = await Promise.all([
    skillPredicate
      ? db
          .select({ techId: serviceRequests.assignedTo, n: count() })
          .from(serviceRequests)
          .where(
            withTenant(
              serviceRequests,
              organizationId,
              and(
                inArray(serviceRequests.assignedTo, ids),
                eq(serviceRequests.status, "completed"),
                skillPredicate,
              )!,
            ),
          )
          .groupBy(serviceRequests.assignedTo)
      : Promise.resolve([] as { techId: string | null; n: number }[]),

    db
      .select({ techId: serviceRequests.assignedTo, rating: avg(reviewRequests.rating) })
      .from(serviceRequests)
      .innerJoin(
        reviewRequests,
        sql`${reviewRequests.serviceRequestId} = ${serviceRequests.id} AND ${reviewRequests.organizationId} = ${organizationId}`,
      )
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          and(inArray(serviceRequests.assignedTo, ids), isNotNull(reviewRequests.rating))!,
        ),
      )
      .groupBy(serviceRequests.assignedTo),

    db
      .select({ techId: serviceRequests.assignedTo, n: count() })
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
  ]);

  for (const r of skillRows) {
    if (r.techId && result.has(r.techId)) {
      result.set(r.techId, { ...result.get(r.techId)!, skillJobsCompleted: Number(r.n) });
    }
  }
  for (const r of ratingRows) {
    if (r.techId && result.has(r.techId)) {
      result.set(r.techId, {
        ...result.get(r.techId)!,
        avgRating: r.rating != null ? Number(r.rating) : null,
      });
    }
  }
  for (const r of loadRows) {
    if (r.techId && result.has(r.techId)) {
      result.set(r.techId, { ...result.get(r.techId)!, sameDayJobCount: Number(r.n) });
    }
  }
  return result;
}
```

- [ ] **Step 2: Write the test**

Create `src/lib/ai/dispatch/signals.test.ts`. This mirrors the repo's `reporting-queries.test.ts` Proxy harness via `vi.hoisted` (so the `vi.mock` factory may safely reference the queue): `db.select(cols)` returns a chainable proxy that resolves to the next queued row-array when awaited. We assert the loader correctly INTERPRETS aggregated rows and defaults missing techs.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectQueue, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const chain = (resolved: unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(resolved);
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };
  return { selectQueue, chain };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
  },
}));

import { loadDispatchSignals } from './signals';

beforeEach(() => {
  selectQueue.length = 0;
});

describe('loadDispatchSignals', () => {
  it('returns a defaulted row for every requested tech even with no data', async () => {
    // job has classification → 3 queries run (skill, rating, load), all empty.
    selectQueue.push([], [], []);
    const m = await loadDispatchSignals('org', ['t1', 't2'], { jobType: 'no_cool', systemType: null }, '2026-06-24');
    expect(m.get('t1')).toEqual({ skillJobsCompleted: 0, avgRating: null, sameDayJobCount: 0 });
    expect(m.get('t2')).toEqual({ skillJobsCompleted: 0, avgRating: null, sameDayJobCount: 0 });
  });

  it('interprets aggregated rows into the per-tech signals', async () => {
    selectQueue.push(
      [{ techId: 't1', n: 7 }], // skill
      [{ techId: 't1', rating: '4.8' }], // rating (driver returns string for avg)
      [{ techId: 't1', n: 2 }], // load
    );
    const m = await loadDispatchSignals('org', ['t1'], { jobType: 'no_cool', systemType: 'central_ac' }, '2026-06-24');
    expect(m.get('t1')).toEqual({ skillJobsCompleted: 7, avgRating: 4.8, sameDayJobCount: 2 });
  });

  it('skips the skill query and matches nobody when the job has no classification', async () => {
    // No jobType/systemType → skill query is short-circuited; only rating+load run.
    selectQueue.push([], []);
    const m = await loadDispatchSignals('org', ['t1'], { jobType: null, systemType: null }, '2026-06-24');
    expect(m.get('t1')!.skillJobsCompleted).toBe(0);
  });

  it('returns an empty map for no technicians without querying', async () => {
    const m = await loadDispatchSignals('org', [], { jobType: 'no_cool', systemType: null }, '2026-06-24');
    expect(m.size).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx vitest run src/lib/ai/dispatch/signals.test.ts`
Expected: PASS. (If the harness `vi` import ordering complains, move `import { vi } from 'vitest';` to the top with the other imports — vitest hoists `vi.mock` regardless.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/dispatch/signals.ts src/lib/ai/dispatch/signals.test.ts
git commit -m "feat(dispatch): add per-technician signals loader"
```

---

## Task 4: Upgrade the orchestrator (`autoAssignBookedRequest`)

**Files:**
- Modify: `src/lib/admin/scheduling-queries.ts:723-762` (the function) + imports + 3 new private helpers
- Test: `src/lib/admin/scheduling-queries.test.ts` (create if absent)

- [ ] **Step 1: Add imports**

At the top of `src/lib/admin/scheduling-queries.ts`, add to the existing schema import group (which already imports `users`, `serviceRequests`):

```typescript
import { organizationSettings } from "@/lib/db/schema";
import { rankTechnicians, type DispatchSignals } from "@/lib/ai/dispatch/score";
import { loadDispatchSignals } from "@/lib/ai/dispatch/signals";
```

(If `serviceRequests`/`users` are imported from `@/lib/db/schema` in a block, add `organizationSettings` to that block instead of a duplicate import line.)

- [ ] **Step 2: Add three private helpers**

Add these ABOVE `autoAssignBookedRequest` in the same file:

```typescript
/** Org opt-in for scored dispatch. Reads the single column fresh (the settings
 * cache is for the chatbot path; a just-flipped toggle takes effect next booking).
 * organization_settings is keyed by organizationId (PK), so eq is the tenant scope. */
async function isAutoDispatchEnabled(organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: organizationSettings.autoDispatchEnabled })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return row?.enabled ?? false;
}

/** The incoming job's classification, for skill matching. */
async function loadJobClassification(
  organizationId: string,
  requestId: string,
): Promise<DispatchSignals["job"] | null> {
  const [row] = await db
    .select({
      jobType: serviceRequests.jobType,
      systemType: serviceRequests.systemType,
      urgency: serviceRequests.urgency,
    })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)));
  return row ? { jobType: row.jobType, systemType: row.systemType, urgency: row.urgency } : null;
}

/** Flag a request as system-assigned (cosmetic; drives the board "Auto" badge). */
async function markAutoAssigned(organizationId: string, requestId: string): Promise<void> {
  await db
    .update(serviceRequests)
    .set({ autoAssigned: true, updatedAt: new Date() })
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)));
}

/** Build the ranked, skill-matched technician order for a scored auto-assign.
 * Returns DB-order ids when no classification exists (degrades to first-fit-like). */
async function rankedTechnicianOrder(
  organizationId: string,
  requestId: string,
  technicianIds: readonly string[],
  isoDay: string,
): Promise<string[]> {
  const job = await loadJobClassification(organizationId, requestId);
  if (!job) return [];
  const signalsByTech = await loadDispatchSignals(organizationId, technicianIds, job, isoDay);
  const candidates: DispatchSignals[] = technicianIds.map((technicianId) => {
    const s = signalsByTech.get(technicianId)!;
    return {
      job,
      tech: {
        technicianId,
        skillJobsCompleted: s.skillJobsCompleted,
        avgRating: s.avgRating,
        sameDayJobCount: s.sameDayJobCount,
      },
    };
  });
  return rankTechnicians(candidates).map((r) => r.technicianId);
}
```

- [ ] **Step 3: Replace the body of `autoAssignBookedRequest`**

Replace the existing loop (the `for (const tech of techs)` block) so the function reads:

```typescript
export async function autoAssignBookedRequest(
  organizationId: string,
  requestId: string,
  heldSlot: {
    readonly start: Date;
    readonly end: Date;
    readonly isoDay: string;
    readonly window: ArrivalWindow;
  },
): Promise<{ readonly assigned: boolean; readonly technicianId?: string }> {
  const techs = await db
    .select({ id: users.id })
    .from(users)
    .where(
      withTenant(
        users,
        organizationId,
        and(eq(users.role, "technician"), eq(users.isActive, true))!,
      ),
    );
  if (techs.length === 0) return { assigned: false };

  // Scored mode (org opt-in) ranks skill-matched techs best-first; otherwise we
  // keep today's first-fit (DB order) for zero behavior change.
  const enabled = await isAutoDispatchEnabled(organizationId);
  const order = enabled
    ? await rankedTechnicianOrder(
        organizationId,
        requestId,
        techs.map((t) => t.id),
        heldSlot.isoDay,
      )
    : techs.map((t) => t.id);

  for (const technicianId of order) {
    const result = await placeAndAssignRequest(
      organizationId,
      requestId,
      { start: heldSlot.start, end: heldSlot.end },
      { isoDay: heldSlot.isoDay, window: heldSlot.window, technicianId },
    );
    if (result.ok) {
      await markAutoAssigned(organizationId, requestId);
      return { assigned: true, technicianId };
    }
    // A conflict (busy) or a tech deactivated mid-flight just means THIS tech
    // can't take it — try the next. Only a request-level failure means stop.
    if (result.reason !== "conflict" && result.reason !== "technician_not_found") {
      break;
    }
  }
  return { assigned: false };
}
```

> Note: in scored mode, `order` is already filtered to skill-matched techs — an unqualified tech is never tried. In disabled mode, `order` is every active tech in DB order (exactly today). `markAutoAssigned` runs on success in BOTH modes (both are system assignments), which is truthful and what the badge reflects.

- [ ] **Step 4: Write the orchestrator test**

Create `src/lib/admin/scheduling-queries.test.ts` (or append a `describe` if it exists). The pure ranking is already proven in Task 2, so this test proves only the orchestrator's THREE branches: disabled→DB order, enabled→ranked order, and no-fit→`{assigned:false}`. It mocks `@/lib/db` (techs + settings reads), stubs the sibling `signals`/`score` modules, and spies on the real `placeAndAssignRequest`.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: false,
  techIds: ['t1', 't2'] as string[],
  ranked: ['t2', 't1'] as string[],
  okTech: 't2' as string | null,
  marked: [] as string[],
  placedAttempts: [] as string[],
}));

vi.mock('@/lib/db', () => {
  const techRows = () => h.techIds.map((id) => ({ id }));
  const settingsRows = () => [{ enabled: h.enabled }];
  let call = 0;
  const proxy = (rows: () => unknown) => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') return (r: (v: unknown) => void) => r(rows());
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };
  return {
    db: {
      // 1st select = techs, 2nd = settings (isAutoDispatchEnabled), others = []
      select: () => {
        call += 1;
        if (call === 1) return proxy(techRows);
        if (call === 2) return proxy(settingsRows);
        return proxy(() => []);
      },
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    },
  };
});

vi.mock('@/lib/ai/dispatch/signals', () => ({
  loadDispatchSignals: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/ai/dispatch/score', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/dispatch/score')>()),
  rankTechnicians: () => h.ranked.map((technicianId) => ({ technicianId, score: 1, reasons: [], skillMatched: true })),
}));

// Spy on the real placeAndAssignRequest in the same module.
import * as sched from './scheduling-queries';

beforeEach(() => {
  h.enabled = false;
  h.marked = [];
  h.placedAttempts = [];
  vi.restoreAllMocks();
  vi.spyOn(sched, 'placeAndAssignRequest').mockImplementation(async (_org, _req, _aw, opts) => {
    h.placedAttempts.push(opts.technicianId!);
    return opts.technicianId === h.okTech
      ? ({ ok: true } as never)
      : ({ ok: false, reason: 'conflict' } as never);
  });
});

const slot = { start: new Date('2026-06-24T15:00:00Z'), end: new Date('2026-06-24T17:00:00Z'), isoDay: '2026-06-24', window: 'afternoon' as never };

describe('autoAssignBookedRequest', () => {
  it('disabled (default): tries techs in DB order (first-fit, unchanged)', async () => {
    h.enabled = false;
    h.okTech = 't2';
    const r = await sched.autoAssignBookedRequest('org', 'req', slot);
    expect(r).toEqual({ assigned: true, technicianId: 't2' });
    expect(h.placedAttempts).toEqual(['t1', 't2']); // DB order
  });

  it('enabled: tries techs in ranked order (best first)', async () => {
    h.enabled = true;
    h.okTech = 't1';
    const r = await sched.autoAssignBookedRequest('org', 'req', slot);
    expect(r).toEqual({ assigned: true, technicianId: 't1' });
    expect(h.placedAttempts[0]).toBe('t2'); // ranked: t2 tried first, conflicts, falls to t1
  });

  it('returns {assigned:false} when nobody fits', async () => {
    h.enabled = true;
    h.okTech = null;
    const r = await sched.autoAssignBookedRequest('org', 'req', slot);
    expect(r).toEqual({ assigned: false });
  });
});
```

> If `vi.spyOn` on a same-module export does not take effect under the project's bundler (ESM live-binding), fall back to asserting the two BRANCHES purely: this test's value is proving (a) disabled→DB order, (b) enabled→ranked order, (c) no-fit→{assigned:false}. Keep whichever harness the existing `scheduling-queries` tests already use; mirror it.

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/lib/admin/scheduling-queries.test.ts`
Expected: PASS — all three branch cases.

- [ ] **Step 6: Verify the build + types**

Run: `npx tsc --noEmit && npm run lint`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin/scheduling-queries.ts src/lib/admin/scheduling-queries.test.ts
git commit -m "feat(dispatch): scored skill-gated upgrade to autoAssignBookedRequest"
```

---

## Task 5: Org-config plumbing for the toggle

**Files:**
- Modify: `src/lib/admin/org-config-types.ts` (zod schema ~line 75-124, `OrgConfig` ~line 130, `DEFAULT_ORG_CONFIG` ~line 147)
- Modify: `src/lib/admin/org-config-queries.ts` (`getOrgConfig` ~line 36, `updateOrgConfig` ~line 64)

- [ ] **Step 1: Add `autoDispatchEnabled` to the zod update schema**

In `src/lib/admin/org-config-types.ts`, inside the `orgConfigUpdateSchema` object (alongside `chatMaxTurns`, `afterHoursConfig`), add:

```typescript
    autoDispatchEnabled: z.boolean().optional(),
```

- [ ] **Step 2: Add it to the `OrgConfig` interface**

In the `OrgConfig` interface, after `afterHoursConfig`:

```typescript
  // Opt-in to Probook-style scored auto-dispatch (default false = first-fit).
  readonly autoDispatchEnabled: boolean;
```

- [ ] **Step 3: Add it to `DEFAULT_ORG_CONFIG`**

In `DEFAULT_ORG_CONFIG`, after `afterHoursConfig: DEFAULT_AFTER_HOURS_CONFIG,`:

```typescript
  autoDispatchEnabled: false,
```

- [ ] **Step 4: Read it in `getOrgConfig`**

In `src/lib/admin/org-config-queries.ts`, in the returned object of `getOrgConfig`, after `afterHoursConfig: resolveAfterHoursConfig(...)`:

```typescript
    autoDispatchEnabled: row.autoDispatchEnabled ?? false,
```

- [ ] **Step 5: Write it in `updateOrgConfig`**

In `updateOrgConfig`, in the patch-building block, after the `afterHoursConfig` line:

```typescript
  if (update.autoDispatchEnabled !== undefined)
    patch.autoDispatchEnabled = update.autoDispatchEnabled;
```

And in the `.values({...})` insert object (so a brand-new row gets a value), after `afterHoursConfig: update.afterHoursConfig ?? null,`:

```typescript
      autoDispatchEnabled: update.autoDispatchEnabled ?? false,
```

- [ ] **Step 6: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors. (If `getOrgConfig`'s return type complains that `autoDispatchEnabled` is missing, you forgot Step 4; if `OrgConfig` complains, Step 2/3.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin/org-config-types.ts src/lib/admin/org-config-queries.ts
git commit -m "feat(dispatch): thread autoDispatchEnabled through org config"
```

---

## Task 6: Settings UI toggle (Dispatch panel)

**Files:**
- Create: `src/components/admin/settings/dispatch-panel.tsx`
- Modify: `src/app/admin/(dashboard)/settings/page.tsx` (add a "Dispatch" tab)

- [ ] **Step 1: Create the panel**

Create `src/components/admin/settings/dispatch-panel.tsx` (mirrors the existing panel pattern, e.g. `conversation-limits-panel.tsx`):

```typescript
'use client';

import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import type { OrgConfig, OrgConfigUpdate } from '@/lib/admin/org-config-types';

interface DispatchPanelProps {
  readonly config: OrgConfig;
  readonly onSave: (update: OrgConfigUpdate) => Promise<boolean>;
}

export function DispatchPanel({ config, onSave }: DispatchPanelProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleToggle(next: boolean): Promise<void> {
    setSaving(true);
    setSaved(false);
    const ok = await onSave({ autoDispatchEnabled: next });
    setSaving(false);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Auto-dispatch</CardTitle>
        <CardDescription>
          When on, a newly booked job is automatically assigned to the best
          qualified technician — ranked by their experience with the job type,
          their ratings, and how busy their day already is. When off, jobs are
          assigned to the first available technician.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="auto-dispatch-switch">Smart auto-dispatch</Label>
            <p className="text-sm text-muted-foreground">
              Assign by skill, quality, and load instead of first-available.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            {saved && <Check className="size-4 text-green-600" />}
            <Switch
              id="auto-dispatch-switch"
              checked={config.autoDispatchEnabled}
              disabled={saving}
              onCheckedChange={(v) => void handleToggle(v)}
              aria-label="Toggle smart auto-dispatch"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

> Verify the `Switch` prop name: open `src/components/ui/switch.tsx` and confirm it forwards `checked` + `onCheckedChange` (Radix default). If the repo's wrapper renames them, match the wrapper.

- [ ] **Step 2: Add the tab to the settings page**

In `src/app/admin/(dashboard)/settings/page.tsx`:

1. Add the import near the other panel imports:

```typescript
import { DispatchPanel } from '@/components/admin/settings/dispatch-panel';
```

2. Add an icon to the existing `lucide-react` import (e.g. `Truck`):

```typescript
  Truck,
```

3. Add a `<TabsTrigger>` in the `<TabsList>` (after the conversation-limits trigger):

```tsx
            <TabsTrigger value="dispatch">
              <Truck className="mr-1.5 size-4" />
              Dispatch
            </TabsTrigger>
```

4. Add the matching `<TabsContent>` (next to the other `TabsContent` blocks); `settings.config` is non-null inside the loaded branch:

```tsx
          <TabsContent value="dispatch">
            <DispatchPanel config={settings.config} onSave={settings.saveConfig} />
          </TabsContent>
```

> Match the EXACT prop shapes the other `TabsContent` panels use on this page (some pass `config={settings.config!}` or destructure differently). Mirror the sibling `ConversationLimitsPanel` usage verbatim, swapping the component name.

- [ ] **Step 3: Verify build + types + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 0 errors.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run: `npm run db:migrate` (apply Task 1 columns to the dev DB), then `npm run dev`, open `/admin/settings`, click the **Dispatch** tab, toggle the switch, reload — the state persists.

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/settings/dispatch-panel.tsx "src/app/admin/(dashboard)/settings/page.tsx"
git commit -m "feat(dispatch): add auto-dispatch settings toggle"
```

---

## Task 7: Dispatch board "Auto" badge

**Files:**
- Modify: `src/lib/admin/queries.ts` (`dashboardRequestSelect`, `DashboardRequestRow` type, `toDashboardRequest`)
- Modify: `src/lib/admin/types.ts` (`DashboardRequest` interface)
- Modify: `src/components/admin/dispatch/dispatch-column.tsx` (`JobCard`)

- [ ] **Step 1: Add `autoAssigned` to `DashboardRequest`**

In `src/lib/admin/types.ts`, in the `DashboardRequest` interface, after `holdReason`:

```typescript
  readonly autoAssigned: boolean;
```

- [ ] **Step 2: Select the column**

In `src/lib/admin/queries.ts`, in `dashboardRequestSelect`, after `holdReason: serviceRequests.holdReason,`:

```typescript
  autoAssigned: serviceRequests.autoAssigned,
```

- [ ] **Step 3: Add it to the `DashboardRequestRow` type**

In the `DashboardRequestRow` type (just below `dashboardRequestSelect`), after the `holdReason` field, add:

```typescript
  readonly autoAssigned: boolean;
```

- [ ] **Step 4: Map it in `toDashboardRequest`**

In `toDashboardRequest`, after `holdReason: row.holdReason,`:

```typescript
    autoAssigned: row.autoAssigned,
```

- [ ] **Step 5: Render the badge in `JobCard`**

In `src/components/admin/dispatch/dispatch-column.tsx`, in `JobCard`, change the header row that holds the time + after-hours chip to also show an "Auto" chip. Replace:

```tsx
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium tabular-nums">
          {formatTime(job.arrivalWindowStart)}
        </span>
        {job.isAfterHours && (
          <span
            title="After hours"
            className="inline-flex shrink-0 items-center rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
          >
            After-hrs
          </span>
        )}
      </div>
```

with:

```tsx
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium tabular-nums">
          {formatTime(job.arrivalWindowStart)}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {job.autoAssigned && (
            <span
              title="Auto-assigned by smart dispatch"
              className="inline-flex items-center rounded-full border border-sky-300 bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800"
            >
              Auto
            </span>
          )}
          {job.isAfterHours && (
            <span
              title="After hours"
              className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
            >
              After-hrs
            </span>
          )}
        </div>
      </div>
```

- [ ] **Step 6: Verify build + types + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 0 errors. (tsc will flag every other place that builds a `DashboardRequest` literal without `autoAssigned` — search for them and add `autoAssigned: <source>.autoAssigned` or `false` where there is no row. Check `getDashboardOverview`, the scheduling-calendar mapper, and any test fixtures.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin/queries.ts src/lib/admin/types.ts src/components/admin/dispatch/dispatch-column.tsx
git commit -m "feat(dispatch): show Auto badge on auto-assigned job cards"
```

---

## Final verification (after all tasks)

- [ ] **Full test suite:** `npm run test:unit` — new dispatch tests green; no regressions beyond the documented vitest-env baseline failures (DB/server suites that fail at import without `.env.local`).
- [ ] **Types + lint:** `npx tsc --noEmit && npm run lint` — 0 errors.
- [ ] **Build:** `npm run build` — succeeds.
- [ ] **Chatbot evals unaffected:** `npm run eval` — 30/30 (this change touches no chatbot prompt/path; if it can't run without keys, note that and skip).
- [ ] **Migration applied to the target DB:** `npm run db:migrate` (the two `DEFAULT false` columns; safe, additive).
- [ ] **Manual E2E (dev):** opt an org in via Settings → Dispatch, book a request through intake with a `jobType`/`systemType`, confirm in the dispatch board that it auto-assigns to a skill-matched tech and shows the **Auto** badge; with the toggle off, confirm first-fit still assigns (no Auto-badge regression on existing flows).

---

## Notes for the implementer

- **neon-http has no transactions.** `placeAndAssignRequest` is the atomic assignment primitive (status-guarded UPDATE) — do NOT wrap it. `markAutoAssigned` is a deliberate second write; a freeze between them leaves a correctly-assigned job whose `auto_assigned` flag is false (cosmetic only).
- **Tenant scoping is mandatory.** Every new query uses `withTenant(table, organizationId, ...)` except reads of `organization_settings`, which is keyed by `organizationId` (PK) so a plain `eq(organizationSettings.organizationId, organizationId)` IS the scope.
- **Default OFF.** `auto_dispatch_enabled` defaults false; an org that never opts in keeps byte-for-byte today's first-fit behavior. This is the core safety property — preserve it.
- **No LLM, no new request lifecycle, no new API route.** The scorer is pure; the orchestrator runs in the existing intake `after()` block; the board/settings reuse existing surfaces.
- **Out of scope (v2, do NOT build):** tech push notification, `technician_skills` table, proximity scoring, tunable threshold, customer messaging, reconcile sweep, route optimization. See the spec's Scope section.
