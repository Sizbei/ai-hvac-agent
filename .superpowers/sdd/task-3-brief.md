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

