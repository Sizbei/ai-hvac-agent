# Forecasting Rollups + Rung A (Probook v3, Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the forecasting spine — nightly daily rollups (`demand_daily`, `revenue_daily`) and **Rung A** deterministic forecasters (seasonal-naïve demand; partitioned three-stream revenue), persisted to `forecast_snapshots`, with a read API and a minimal owner cockpit. No models that need training data.

**Architecture:** Pure forecasters (series-in / forecast-out, unit-tested like `dispatch/score.ts`) sit behind a cron that (1) refreshes rollups from raw timestamps (business-TZ bucketed), (2) runs the forecasters, (3) writes versioned snapshots — each sub-step independently idempotent (no cross-step atomicity; neon-http has no transactions). The cockpit reads the latest snapshot.

**Tech Stack:** Drizzle/neon-http (aggregates → strings → `Number()`; `db.batch`; no transactions), Next.js cron + admin page, Vitest.

**Source spec:** `docs/superpowers/specs/2026-06-24-probook-master-spec-v3.md` §6.2 (hardened). **Phase 4** of §8.

**Migrations (authored here via `db:generate`; OPERATOR applies via `db:migrate`):** `fc-1` (`demand_daily`, `revenue_daily`), `fc-2` (`forecast_snapshots`, `forecast_accuracy`). Additive.

**Hard constraints carried from the spec review (do not regress):**
- **Native vs synced revenue never blended** — `revenue_daily.basis` discriminates; forecast only the **single data-richest basis** as the headline (the other is a deterministic roll-forward). *The basis choice is operator Q3 — Phase 4 reads it from config/param; do not hardcode.*
- **Revenue is a strict partition with precedence** (booked → pipeline-excluding-booked → MRR-excluding-materialized) with a **set-disjointness assertion** — never sum-vs-realized.
- **Count data:** demand forecasts and any interval bounds **floored at 0**; sparse series stay on seasonal-naïve.
- **Business-TZ bucketing** (`calendar-time.ts` `businessIsoDate`), not raw UTC `date_trunc`.
- **Forecasting is read-only** against `invoices`/`payments`/`estimates`/`service_requests`; it writes only the four new tables.
- **Cold-start honesty:** show only horizons the history supports; never present an un-backtested horizon as validated.

---

## File Structure

- `src/lib/db/schema.ts` — **modify**: `demandDaily`, `revenueDaily`, `forecastSnapshots`, `forecastAccuracy`.
- `drizzle/0024_*.sql` (fc-1) and `drizzle/0025_*.sql` (fc-2) — **generated**. Operator applies.
- `src/lib/forecasting/seasonal-naive.ts` (+ `.test.ts`) — **create**: pure demand forecaster.
- `src/lib/forecasting/revenue.ts` (+ `.test.ts`) — **create**: pure partitioned revenue forecaster + disjointness assertion.
- `src/lib/forecasting/rollups.ts` (+ `.test.ts`) — **create**: `refreshDailyRollups` (business-TZ buckets, idempotent upserts).
- `src/lib/forecasting/run.ts` — **create**: orchestration → `forecast_snapshots`.
- `src/app/api/cron/run-forecasts/route.ts` (+ `.test.ts`) — **create**: auth, per-org refresh+run.
- `src/lib/forecasting/read.ts` — **create**: `getForecast(orgId, kind, horizonDays)`.
- `src/app/admin/forecast/...` — **create**: minimal cockpit page (reads `getForecast`).

---

## Task 1: Schema — the four forecasting tables (two migrations)

**Files:** Modify `src/lib/db/schema.ts`; generate `0024` (fc-1) then `0025` (fc-2).

- [ ] **Step 1: Add the tables** (mirror the `customerEvents` index style; all counts/cents are integers; no PII anywhere)

```ts
export const demandDaily = pgTable("demand_daily", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  // NOT NULL with a sentinel for the all-types row: Postgres treats NULLs as
  // DISTINCT in a plain unique index, so a NULL "all types" row would never
  // match onConflictDoUpdate and would duplicate on every cron run. Use the
  // literal '__all__' for the all-types rollup row instead of NULL.
  jobType: text("job_type").notNull().default("__all__"),
  bookings: integer("bookings").notNull().default(0),
  sessions: integer("sessions").notNull().default(0),
  booked: integer("booked").notNull().default(0),
}, (t) => [uniqueIndex("demand_daily_org_day_jobtype_unique").on(t.organizationId, t.day, t.jobType)]);

export const revenueDaily = pgTable("revenue_daily", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  basis: text("basis").notNull(), // 'native_payment' | 'synced_creation' — NEVER blended
  collectedCents: integer("collected_cents").notNull().default(0),
  invoicedCents: integer("invoiced_cents").notNull().default(0),
  refundedCents: integer("refunded_cents").notNull().default(0),
}, (t) => [uniqueIndex("revenue_daily_org_day_basis_unique").on(t.organizationId, t.day, t.basis)]);

export const forecastSnapshots = pgTable("forecast_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // 'demand' | 'revenue' | 'capacity'
  model: text("model").notNull(), // 'seasonal_naive' | 'revenue_partition' | ...
  horizonDays: integer("horizon_days").notNull(),
  segment: text("segment"), // jobType / revenue basis
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  payload: jsonb("payload").notNull(), // {points:[{day,value,lo?,hi?}], inputs:{...}, explanation?}
}, (t) => [index("forecast_snapshots_org_kind_gen_idx").on(t.organizationId, t.kind, t.generatedAt)]);

export const forecastAccuracy = pgTable("forecast_accuracy", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  model: text("model").notNull(),
  segment: text("segment"),
  horizonDays: integer("horizon_days").notNull(),
  forDay: date("for_day").notNull(),
  predicted: integer("predicted").notNull(),
  actual: integer("actual"), // filled when the day passes
  absError: integer("abs_error"), // |actual - predicted| — MASE numerator (NOT a percentage)
}, (t) => [uniqueIndex("forecast_accuracy_unique").on(t.organizationId, t.kind, t.segment, t.horizonDays, t.forDay)]);
```

**`jsonb` and `uniqueIndex` are already imported in `schema.ts`, but `date` is NOT** — add `date` to the `drizzle-orm/pg-core` import (it's used nowhere as a column type yet, so `tsc` will error until added).

- [ ] **Step 2:** `npm run db:generate` twice is not needed — one run emits both new tables. (If you want two migrations, add `demandDaily`+`revenueDaily` first, generate `0024`, then add the snapshot tables, generate `0025`. Single migration is acceptable too.) **Do not** `db:migrate`.

- [ ] **Step 3:** `npx tsc --noEmit` → 0. **Commit:** `git add src/lib/db/schema.ts drizzle/ && git commit -m "feat(forecasting): demand/revenue rollups + snapshot/accuracy tables (fc-1/fc-2)"`

---

## Task 2: Pure seasonal-naïve demand forecaster (the most-reviewed unit)

**Files:** Create `src/lib/forecasting/seasonal-naive.ts` + `.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { seasonalNaive, type DailyPoint } from "./seasonal-naive";

// Build a series with a clear weekly pattern: Mondays=10, others=2.
function series(weeks: number): DailyPoint[] {
  const out: DailyPoint[] = [];
  const start = new Date("2026-01-05T00:00:00Z"); // a Monday
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    out.push({ day: d.toISOString().slice(0, 10), value: d.getUTCDay() === 1 ? 10 : 2 });
  }
  return out;
}

describe("seasonalNaive", () => {
  it("forecasts the same weekday's recent average (Monday→~10)", () => {
    const f = seasonalNaive(series(6), 7);
    const mon = f.find((p) => new Date(p.day + "T00:00:00Z").getUTCDay() === 1)!;
    expect(mon.value).toBe(10);
  });

  it("never returns a negative forecast (floored at 0)", () => {
    const f = seasonalNaive([{ day: "2026-01-05", value: 0 }, { day: "2026-01-06", value: 0 }], 3);
    expect(f.every((p) => p.value >= 0)).toBe(true);
  });

  it("returns exactly `horizonDays` future points, contiguous from the last day", () => {
    const f = seasonalNaive(series(4), 5);
    expect(f).toHaveLength(5);
    // series(4) = 28 points, days i=0..27 from Mon 2026-01-05 → last day is i=27 = Sun 2026-02-01;
    // the first forecast is the day AFTER the last day = Mon 2026-02-02.
    expect(f[0].day).toBe("2026-02-02");
  });

  it("falls back to the overall mean when there's <1 week of history", () => {
    const f = seasonalNaive([{ day: "2026-01-05", value: 4 }, { day: "2026-01-06", value: 8 }], 2);
    expect(f.every((p) => p.value === 6)).toBe(true); // mean(4,8)=6, floored, rounded
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```ts
// src/lib/forecasting/seasonal-naive.ts
export interface DailyPoint { readonly day: string; readonly value: number; }      // day = ISO yyyy-mm-dd
export interface ForecastPoint { readonly day: string; readonly value: number; readonly lo?: number; readonly hi?: number; }

const WEEKDAY_LOOKBACK = 4; // same-weekday last-4-weeks (spec §6.2.1)

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  return new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}
function weekdayOf(iso: string): number { return new Date(iso + "T00:00:00Z").getUTCDay(); }
const floorNonNeg = (n: number) => Math.max(0, Math.round(n));

/**
 * Rung A demand forecaster: seasonal-naïve over same-weekday-last-4-weeks.
 * Floors at 0 (count data). Falls back to the overall mean when there is less
 * than one full week of history. PURE: series in, forecast out. Intervals are
 * left undefined here — h-step prediction bands come from the Phase 8 backtest.
 */
export function seasonalNaive(series: readonly DailyPoint[], horizonDays: number): ForecastPoint[] {
  if (series.length === 0) return [];
  const sorted = [...series].sort((a, b) => a.day.localeCompare(b.day));
  const lastDay = sorted[sorted.length - 1].day;
  const haveAWeek = sorted.length >= 7;
  const overallMean = sorted.reduce((s, p) => s + p.value, 0) / sorted.length;

  // Index recent values by weekday (most-recent first).
  const byWeekday = new Map<number, number[]>();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const wd = weekdayOf(sorted[i].day);
    const arr = byWeekday.get(wd) ?? [];
    if (arr.length < WEEKDAY_LOOKBACK) arr.push(sorted[i].value);
    byWeekday.set(wd, arr);
  }

  const out: ForecastPoint[] = [];
  for (let h = 1; h <= horizonDays; h++) {
    const day = addDaysIso(lastDay, h);
    let value: number;
    if (!haveAWeek) {
      value = overallMean;
    } else {
      const recent = byWeekday.get(weekdayOf(day));
      value = recent && recent.length > 0 ? recent.reduce((s, v) => s + v, 0) / recent.length : overallMean;
    }
    out.push({ day, value: floorNonNeg(value) });
  }
  return out;
}
```

- [ ] **Step 4: Run → pass.** Commit: `git add src/lib/forecasting/seasonal-naive.* && git commit -m "feat(forecasting): pure seasonal-naive demand forecaster (count-floored)"`

---

## Task 3: Pure partitioned revenue forecaster (+ disjointness assertion)

**Files:** Create `src/lib/forecasting/revenue.ts` + `.test.ts`.

- [ ] **Step 1: Write the failing test**

Cover the partition + the disjointness guard:
- An estimate whose `serviceRequestId` is in the booked set is **excluded** from pipeline (no double-count).
- Pipeline value = `totalCents × closeProb(ageDays)` summed; mass the close curve places beyond the horizon is **not** added.
- A membership period already represented by a materialized scheduled visit is excluded from MRR.
- `assertDisjoint(streams)` throws if any `serviceRequestId`/`estimateId` appears in two streams.
- Total = booked + pipeline + mrr.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement (pure)**

```ts
// src/lib/forecasting/revenue.ts
export interface BookedJob { readonly serviceRequestId: string; readonly estimateId: string | null; readonly cents: number; }
export interface OpenEstimate { readonly estimateId: string; readonly serviceRequestId: string | null; readonly totalCents: number; readonly ageDays: number; }
export interface MrrPeriod { readonly key: string; readonly materializedServiceRequestId: string | null; readonly cents: number; }

export interface RevenueForecast {
  readonly bookedCents: number;
  readonly pipelineCents: number;
  readonly mrrCents: number;
  readonly totalCents: number;
}

/** closeProb: P(converts within the horizon | survived to ageDays) — read off the survival curve, in [0,1]. */
export function forecastRevenue(input: {
  booked: readonly BookedJob[];
  openEstimates: readonly OpenEstimate[];
  mrr: readonly MrrPeriod[];
  closeProbWithinHorizon: (ageDays: number) => number;
}): RevenueForecast {
  const bookedEstimateIds = new Set(input.booked.map((b) => b.estimateId).filter((x): x is string => x != null));
  const bookedReqIds = new Set(input.booked.map((b) => b.serviceRequestId));

  const bookedCents = input.booked.reduce((s, b) => s + b.cents, 0);

  // Pipeline excludes estimates already consumed by a booked job.
  const pipelineCents = input.openEstimates
    .filter((e) => !bookedEstimateIds.has(e.estimateId) && !(e.serviceRequestId && bookedReqIds.has(e.serviceRequestId)))
    .reduce((s, e) => s + Math.round(e.totalCents * clamp01(input.closeProbWithinHorizon(e.ageDays))), 0);

  // MRR excludes periods already materialized into a booked job.
  const mrrCents = input.mrr
    .filter((m) => !(m.materializedServiceRequestId && bookedReqIds.has(m.materializedServiceRequestId)))
    .reduce((s, m) => s + m.cents, 0);

  return { bookedCents, pipelineCents, mrrCents, totalCents: bookedCents + pipelineCents + mrrCents };
}

const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1);

/**
 * Dev/test guard — must cover the SAME dimensions forecastRevenue excludes on
 * (estimateId AND serviceRequestId AND MRR's materialized request), or it gives
 * false confidence. Throws if any entity appears in two streams.
 */
export function assertDisjoint(input: {
  booked: readonly BookedJob[];
  openEstimates: readonly OpenEstimate[];
  mrr: readonly MrrPeriod[];
}): void {
  const bookedEst = new Set(input.booked.map((b) => b.estimateId).filter(Boolean) as string[]);
  const bookedReq = new Set(input.booked.map((b) => b.serviceRequestId));
  for (const e of input.openEstimates) {
    if (bookedEst.has(e.estimateId))
      throw new Error(`estimate ${e.estimateId} counted in both booked and pipeline`);
    if (e.serviceRequestId && bookedReq.has(e.serviceRequestId))
      throw new Error(`estimate ${e.estimateId} (req ${e.serviceRequestId}) overlaps a booked job`);
  }
  for (const m of input.mrr) {
    if (m.materializedServiceRequestId && bookedReq.has(m.materializedServiceRequestId))
      throw new Error(`MRR period ${m.key} overlaps a booked materialized visit`);
  }
}
```

- [ ] **Step 4: Run → pass.** Commit: `git add src/lib/forecasting/revenue.* && git commit -m "feat(forecasting): pure partitioned revenue forecaster (no double-count)"`

---

## Task 4: `refreshDailyRollups` — business-TZ buckets, idempotent

**Files:** Create `src/lib/forecasting/rollups.ts` + `.test.ts`.

- [ ] **Step 1: Write the failing test** (db mocked): asserts demand rows upsert per `(org, day, jobType)` and revenue rows per `(org, day, basis)` using `onConflictDoUpdate` (idempotent re-run), and that day buckets use the business-TZ helper (a late-evening-Eastern `createdAt` lands on the correct business day).

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

`refreshDailyRollups(organizationId, sinceDay?)`:
- Demand: aggregate `service_requests` by business-day(`createdAt`) and `jobType` (count = bookings); aggregate `customer_sessions` by business-day(`createdAt`) for `sessions` and `booked` (outcome='booked'). Coerce counts with `Number()`. Upsert into `demand_daily` keyed by the unique index.
- Revenue: **native_payment** basis from `payments` where `status='succeeded'` by business-day(`createdAt`); **synced_creation** basis from `invoices` where `fieldpulseInvoiceId IS NOT NULL OR hcpInvoiceId IS NOT NULL` by business-day(`createdAt`), `state IN ('open','paid')`. Keep them as **separate rows** (different `basis`) — never summed. Upsert into `revenue_daily`.
- Use the `calendar-time.ts` `businessIsoDate` helper for bucketing (do the day assignment in JS over fetched timestamps, or via a TZ-aware SQL expression — JS is simpler and avoids a UTC `date_trunc` bug). Each upsert is independently idempotent.

- [ ] **Step 4: Run → pass; `npx tsc --noEmit` → 0.** Commit.

---

## Task 5: Orchestration + cron

**Files:** Create `src/lib/forecasting/run.ts`, `src/app/api/cron/run-forecasts/route.ts` (+ test).

- [ ] **Step 1:** `runForecasts(orgId, {horizons:[7,30], basis})`:
  - `refreshDailyRollups(orgId)`.
  - Load the demand series from `demand_daily`; run `seasonalNaive` per horizon; write a `forecast_snapshots` row (kind='demand', model='seasonal_naive', payload {points}).
  - Load the revenue inputs (booked/openEstimates/mrr for the **operator-chosen basis** — passed in, NOT hardcoded; see Q3); run `forecastRevenue`; write a snapshot (kind='revenue', model='revenue_partition').
  - Each write idempotent; honor cold-start (skip a horizon the history can't support, and mark it in the payload).
- [ ] **Step 2:** Cron route mirrors `generate-membership-visits` but note the exact auth signature is `verifyCronAuth(request.headers.get("authorization"))` (it takes the header string, not the request). **Iterate orgs from the `organizations` table (active/non-deleted) — NOT the membership filter the template uses** (every org needs forecasts, with or without memberships). Use `'__all__'` for the all-types demand rollup row (not NULL). Shipping it scheduled is acceptable (read-only, no outbound) — but confirm with the operator before adding a `vercel.json` entry.
- [ ] **Step 3:** Test (auth + calls run). `npx tsc --noEmit` → 0. Commit.

---

## Task 6: Read API + minimal cockpit

**Files:** Create `src/lib/forecasting/read.ts` (`getForecast(orgId, kind, horizonDays)` → latest snapshot) and a minimal `src/app/admin/forecast` page rendering the demand series + revenue three-stream breakdown + a per-horizon credibility badge.

- [ ] **Step 1:** `getForecast` selects the newest `forecast_snapshots` row for `(org, kind, horizonDays)`.
- [ ] **Step 2:** Cockpit page (admin-gated, Spears-branded) reads it; label the revenue basis explicitly (native-collected vs synced-creation); show "insufficient history" where a horizon isn't supported.
- [ ] **Step 3:** `npx tsc --noEmit && npm run lint && npm run build` → green. Commit.

---

## Done criteria (maps to spec G4-conditional / forecasting visible)

- Rollups populate from raw timestamps with business-TZ bucketing; native and synced revenue stay separate.
- Rung A demand (seasonal-naïve, count-floored) and revenue (strict partition, no double-count) snapshots are produced for 7/30-day horizons and shown in the cockpit with honest credibility badges.
- Pure forecasters are unit-tested (the partition/floor/fallback properties especially); forecasting is read-only against money tables; cron steps are idempotent.
- Migrations `fc-1`/`fc-2` authored (operator applies); tsc + lint + forecasting suite + build green.

**Gated on operator Q3:** which revenue basis is the headline. `runForecasts` takes `basis` as a parameter — the cron passes the operator-configured value; do not hardcode. **Out of scope (later):** Holt-Winters/Rung B (Phase 8), prediction intervals (Phase 8 backtest), capacity forecast (Phase 5), LLM explanations (Phase 7).
