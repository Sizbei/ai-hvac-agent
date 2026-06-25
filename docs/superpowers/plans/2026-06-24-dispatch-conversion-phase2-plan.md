# Dispatch Conversion Scoring + Exceptions-Queue Suggestions (Probook v3, Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dispatch ranking *revenue-aware and explainable* — add a **conversion** signal (and avg-job-revenue) to the scorer, re-weight `score.ts`, and surface a **top-3 scored suggestions** (with reasons) on the request detail so a dispatcher trusts/overrides the call.

**Architecture:** Extend the existing pure scorer (`src/lib/ai/dispatch/score.ts`) and its signal loader (`src/lib/ai/dispatch/signals.ts`) with two per-tech signals read from existing tables (no migration). Expose a read-only `suggestTechnicians(orgId, requestId)` that reuses the candidate-building + scorer and returns the top-3 with reasons; surface it via a GET endpoint the dispatch board's request detail consumes (read-only suggestion — the human still commits the assignment).

**Tech Stack:** Drizzle ORM on neon-http (no transactions; aggregates return strings → `Number()`), Next.js App Router, Vitest.

**Source spec:** `docs/superpowers/specs/2026-06-24-probook-master-spec-v3.md` §6.3 (Dispatch Intelligence). This is **Phase 2** of §8's build sequence. **No new migration** — reads existing tables.

**Invariants preserved:** the existing dispatch fail-open guarantee ("opting in never strands a job that first-fit would have placed", `scheduling-queries.ts:849-860`) is untouched — this plan only adds a scoring *term* and a *read-only* suggestion surface; it does not gate assignment. Weights stay tunable constants, explicitly provisional (tuned on pilot data post-launch). neon-http aggregate strings coerced with `Number()`.

---

## File Structure

- `src/lib/ai/dispatch/score.ts` — **modify**: add `conversionRate` + `avgJobRevenueCents` to `DispatchSignals.tech`; add a conversion weight + term + reason.
- `src/lib/ai/dispatch/score.test.ts` — **modify/create**: weight + ordering tests for the conversion term.
- `src/lib/ai/dispatch/signals.ts` — **modify**: add `conversionRate` + `avgJobRevenueCents` to `TechSignalRow` and load them (one added query each, defaulted to 0).
- `src/lib/ai/dispatch/signals.test.ts` — **modify/create**: the new signal queries (db mocked) default + populate.
- `src/lib/ai/dispatch/suggest.ts` — **create**: `suggestTechnicians(orgId, requestId, limit=3)` — reuses candidate building + `rankTechnicians`, returns top-N with reasons. Read-only.
- `src/lib/ai/dispatch/suggest.test.ts` — **create**: returns ranked top-3 (db/scorer mocked); empty when unclassified.
- `src/app/api/admin/dispatch/suggest/[id]/route.ts` — **create**: GET, `getAdminSession` gate, org from session, returns suggestions JSON.
- Dispatch board request-detail component — **modify**: render the top-3 suggestions card (consumes the endpoint). *(Exact component path discovered by the implementer — see Task 6.)*

---

## Task 1: Add the conversion term to the pure scorer

**Files:**
- Modify: `src/lib/ai/dispatch/score.ts`
- Test: `src/lib/ai/dispatch/score.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/ai/dispatch/score.test.ts  (add to the existing file if present)
import { describe, it, expect } from "vitest";
import { scoreTechnician, rankTechnicians, type DispatchSignals } from "./score";

const job = { jobType: "no_cool", systemType: null, urgency: "high" } as const;

function tech(overrides: Partial<DispatchSignals["tech"]> = {}): DispatchSignals {
  return {
    job,
    tech: {
      technicianId: overrides.technicianId ?? "t1",
      skillJobsCompleted: overrides.skillJobsCompleted ?? 5,
      avgRating: overrides.avgRating ?? 4,
      sameDayJobCount: overrides.sameDayJobCount ?? 1,
      conversionRate: overrides.conversionRate ?? 0,
      avgJobRevenueCents: overrides.avgJobRevenueCents ?? 0,
    },
  };
}

describe("scoreTechnician — conversion term", () => {
  it("a higher conversion rate yields a higher score, all else equal", () => {
    const lo = scoreTechnician(tech({ technicianId: "a", conversionRate: 0.1 }));
    const hi = scoreTechnician(tech({ technicianId: "b", conversionRate: 0.9 }));
    expect(hi.score).toBeGreaterThan(lo.score);
  });

  it("includes a conversion reason when conversionRate > 0", () => {
    const r = scoreTechnician(tech({ conversionRate: 0.42 }));
    expect(r.reasons.some((x) => x.includes("42%"))).toBe(true);
  });

  it("conversion can change ranking order between two otherwise-equal techs", () => {
    const ranked = rankTechnicians([
      tech({ technicianId: "a", conversionRate: 0.2 }),
      tech({ technicianId: "b", conversionRate: 0.8 }),
    ]);
    expect(ranked[0].technicianId).toBe("b");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/ai/dispatch/score.test.ts`
Expected: FAIL — `conversionRate`/`avgJobRevenueCents` not on the `tech` type.

- [ ] **Step 3: Implement — extend the type, weights, term, and reason**

In `score.ts`:

```ts
// add to DispatchSignals.tech:
    readonly conversionRate: number;     // 0..1 — sold estimates / estimated jobs for this tech
    readonly avgJobRevenueCents: number; // avg invoice total on the tech's completed jobs

// re-weight (sum to 1.0) — provisional, tuned on pilot data post-launch (spec §6.3):
const W_SKILL = 0.4;
const W_QUALITY = 0.2;
const W_CONVERSION = 0.25;
const W_LOAD = 0.15;
```

In `scoreTechnician`, add the conversion term (clamp to [0,1]) and fold it into `score`:

```ts
  const conversion = Math.min(Math.max(tech.conversionRate, 0), 1);
  const score =
    skillDepth * W_SKILL +
    quality * W_QUALITY +
    conversion * W_CONVERSION +
    load * W_LOAD;
```

Add a reason when conversion is meaningful (after the rating reason):

```ts
  if (tech.conversionRate > 0) {
    reasons.push(`${Math.round(tech.conversionRate * 100)}% close rate`);
  }
```

(`avgJobRevenueCents` is loaded as a signal and shown in suggestions/reasons but is NOT yet a scoring term — kept out of the weighted sum until there's pilot data to weight it; surface it as a reason only if desired in a later slice.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/ai/dispatch/score.test.ts`
Expected: PASS. Also confirm existing score tests still pass (the weight change shifts absolute scores but skill-matched ordering semantics hold).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/dispatch/score.ts src/lib/ai/dispatch/score.test.ts
git commit -m "feat(dispatch): add conversion term to the scorer (re-weighted, explainable)"
```

---

## Task 2: Load the conversion + revenue signals

**Files:**
- Modify: `src/lib/ai/dispatch/signals.ts`
- Test: `src/lib/ai/dispatch/signals.test.ts`

- [ ] **Step 1: Write the failing test (db mocked)**

Mirror the existing signals test setup (mock `@/lib/db`, `@/lib/db/schema`, `@/lib/db/tenant`). Assert that `loadDispatchSignals` returns `conversionRate` and `avgJobRevenueCents` defaulted to 0 for an unknown tech, and populated from the mocked query rows for a known tech. (If `signals.test.ts` doesn't exist yet, create it following the `thread.test.ts` mocking style.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/ai/dispatch/signals.test.ts`
Expected: FAIL — fields absent.

- [ ] **Step 3: Implement**

In `signals.ts`:
1. Extend `TechSignalRow`:
```ts
  readonly conversionRate: number;
  readonly avgJobRevenueCents: number;
```
2. Default them in the seed loop: `result.set(id, { skillJobsCompleted: 0, avgRating: null, sameDayJobCount: 0, conversionRate: 0, avgJobRevenueCents: 0 });`
3. Add two queries to the `Promise.all` block (import `estimates`, `invoices` from schema; import `inArray`/`count`/`avg`/`sql` already present):
   - **Conversion** per tech: join `estimates` → `serviceRequests` on `estimates.serviceRequestId = serviceRequests.id`, scoped to org, `assignedTo IN ids`; compute `sold = count where estimates.status='sold'` and `total = count(estimates)`; `conversionRate = total > 0 ? sold/total : 0`. (Do this as one grouped query selecting `count(*)` and `count(*) filter (where status='sold')` via `sql`, then derive the ratio in JS with `Number()`.)
   - **Avg job revenue** per tech: join `invoices` → `serviceRequests` on `invoices.serviceRequestId = serviceRequests.id`, scoped to org, `assignedTo IN ids`, `serviceRequests.status='completed'`, `invoices.state IN ('open','paid')` (exclude draft/void); `avg(invoices.totalCents)` grouped by `assignedTo`; coerce with `Number()`.
4. Fold both result sets into the map like the existing `skillRows`/`ratingRows`/`loadRows` loops.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/ai/dispatch/signals.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the signals into the candidate builder**

Find where `loadDispatchSignals` results are mapped into `DispatchSignals` for the scorer (in `src/lib/admin/scheduling-queries.ts`, `rankedTechnicianOrder`). Pass the two new fields through into each candidate's `tech` object. Run `npx tsc --noEmit` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/dispatch/signals.ts src/lib/ai/dispatch/signals.test.ts src/lib/admin/scheduling-queries.ts
git commit -m "feat(dispatch): load conversion + avg-job-revenue signals (no migration)"
```

---

## Task 3: `suggestTechnicians` — read-only top-N with reasons

**Files:**
- Create: `src/lib/ai/dispatch/suggest.ts`
- Test: `src/lib/ai/dispatch/suggest.test.ts`

- [ ] **Step 1: Write the failing test**

Test that `suggestTechnicians` returns the ranked top-3 `{technicianId, score, reasons}` for a classified job, and an empty array for an unclassified job (no skill match). Mock the candidate/signals layer and `rankTechnicians`.

- [ ] **Step 2: Run to verify it fails** → module missing.

- [ ] **Step 3: Implement**

```ts
// src/lib/ai/dispatch/suggest.ts
import { rankTechnicians, type RankedTech } from "./score";
// reuse the SAME candidate-building path the auto-assign uses (rankedTechnicianOrder
// internals) so suggestions match what auto-assign would do. Import the existing
// helper that builds DispatchSignals[] for a request; if rankedTechnicianOrder
// already returns RankedTech[], wrap it and slice.

export async function suggestTechnicians(
  organizationId: string,
  serviceRequestId: string,
  limit = 3,
): Promise<RankedTech[]> {
  // Build candidates for the request (active techs + signals), score, take top-N.
  // Returns [] when the job is unclassified / no skill match (mirrors auto-assign).
}
```

Implement by reusing `rankedTechnicianOrder` (or its candidate builder) from `scheduling-queries.ts` and slicing to `limit`. If `rankedTechnicianOrder` returns the ranked list already, `suggestTechnicians` = load request attrs → call it → `.slice(0, limit)`.

- [ ] **Step 4: Run to verify it passes** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/dispatch/suggest.ts src/lib/ai/dispatch/suggest.test.ts
git commit -m "feat(dispatch): suggestTechnicians read-only top-N (reuses scorer)"
```

---

## Task 4: GET suggestions endpoint

**Files:**
- Create: `src/app/api/admin/dispatch/suggest/[id]/route.ts`

- [ ] **Step 1: Implement (mirror an existing admin GET route)**

Read an existing admin route (e.g. `src/app/api/admin/integrations/housecall/bulk-update/route.ts`) for the exact `getAdminSession` 401 pattern, `params` Promise handling (Next.js: `const { id } = await params`), and org-from-session. Then:

```ts
// GET /api/admin/dispatch/suggest/[id]
// - getAdminSession → 401 if absent
// - organizationId from the SESSION (never the body/query)
// - const { id } = await params
// - return { suggestions: await suggestTechnicians(orgId, id, 3) }
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → exit 0. Run: `npm run lint` (new file clean).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/admin/dispatch/suggest
git commit -m "feat(dispatch): GET top-3 technician suggestions endpoint (session-scoped)"
```

---

## Task 5: Endpoint test (auth + shape)

**Files:**
- Create: `src/app/api/admin/dispatch/suggest/[id]/route.test.ts` (or `tests/api/...` per repo convention)

- [ ] **Step 1: Write tests** — 401 without a session; 200 with `{suggestions: [...]}` when authed (mock `getAdminSession` + `suggestTechnicians`); org taken from session, not the request.

- [ ] **Step 2: Run** → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/admin/dispatch/suggest/[id]/route.test.ts
git commit -m "test(dispatch): suggestions endpoint auth + shape"
```

---

## Task 6: Render top-3 suggestions on the request detail (exceptions queue)

**Files:**
- Modify: the dispatch board's request-detail component *(discover the path: grep for the unassigned/request-detail sheet under `src/components/` or `src/app/(admin)`/`src/app/admin` — likely a `dispatch`/`scheduling`/`board` component)*

- [ ] **Step 1: Locate the component**

Run: `grep -rl "Unassigned\|rankedTechnicianOrder\|placeAndAssign\|dispatch" src/components src/app | head`. Identify the request-detail / assignment sheet where a dispatcher assigns a tech.

- [ ] **Step 2: Add a read-only "Suggested technicians" card**

When the detail opens for a request, fetch `GET /api/admin/dispatch/suggest/[id]` and render the top-3 as rows: tech name + score + `reasons.join(" · ")` + a one-click "Assign" that calls the **existing** assignment action (do not add a new assignment path — reuse `placeAndAssignRequest`/the existing assign handler). The suggestion is advisory; the human commits.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run lint && npm run build` → all green (UI verified by tsc + build, matching the tech-portal precedent). Add a component test only if the codebase has a harness for these client components; otherwise tsc+build is the gate.

- [ ] **Step 4: Commit**

```bash
git add <the component file>
git commit -m "feat(dispatch): top-3 suggestion card on the request detail (advisory, reuses assign)"
```

---

## Done criteria (maps to spec G3)

- The scorer ranks on skill + quality + **conversion** + load, with a conversion **reason** in `reasons[]`.
- Signals load conversion + avg-job-revenue from existing tables (no migration).
- A dispatcher sees the **top-3 scored suggestions with reasons** on the request detail and can one-click assign (reusing the existing assign path) or override.
- The existing fail-open assignment guarantee is unchanged (this is additive ranking + a read-only suggestion).
- `npx tsc --noEmit`, `npm run lint`, dispatch unit suites, and `npm run build` are green.

**Out of scope for Phase 2 (later phases):** capacity-aware scoring (Phase 6, needs the capacity forecast), proximity (Phase 10, needs `disp-1`), PTO (Phase 11, `disp-2`), making `avgJobRevenueCents` a weighted scoring term (needs pilot data to weight). These don't block G3.
