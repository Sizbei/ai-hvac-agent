# P0 — Calendar Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two calendar bugs that block daily dispatch use — (1) every lane renders "out of hours," and (2) dragging a card back to the Unscheduled panel does nothing.

**Architecture:** Bug 1 is a pure-function fix in availability coverage: a technician with *zero* availability rows (the unconfigured pre-setup state) falls back to a bounded **default business-hours** window instead of failing closed; a technician with rows but none on that weekday is still correctly "off." Bug 2 adds the missing unschedule direction across the existing drag stack: a droppable Unscheduled zone → a drop-handler branch → a pure optimistic helper → a hook call → a server route + status-guarded mutation that nulls the placement.

**Tech Stack:** Next.js (App Router), TypeScript, Drizzle (neon-http — **no transactions**, use single guarded UPDATEs), @dnd-kit/core, Vitest, Zod.

## Global Constraints

- **Immutability:** never mutate inputs; rebuild lists/objects (matches `calendar-optimistic.ts`).
- **neon-http has no transactions:** use a single status-guarded `UPDATE ... WHERE status = <expected>` for atomicity (the existing pattern in `placeAndAssignRequest`).
- **Pure scheduling math stays pure:** no `Date.now()` / I/O in `availability-coverage.ts` or `calendar-optimistic.ts` (DST handled via business-tz instants).
- **Tenant scoping:** every query uses `withTenant(...)` / `organizationId` exactly as neighboring code does.
- **Default business hours (Bug 1):** Monday–Friday, **8:00 AM–8:00 PM business-tz** (480–1200 minutes). 8–20 exactly covers the `morning`/`afternoon`/`evening`/`anytime` window bounds (`arrival-window.ts:20-25`). Weekends remain off until set via the P1 availability UI.
- **Scope:** P0 is the minimal bug fixes only. The org-configurable default-hours setting, the availability-editing UI, and FieldPulse precedence are **P1**, not here.

---

### Task 1: Bug 1 — default-business-hours fallback for unconfigured technicians

**Files:**
- Modify: `src/lib/admin/availability-coverage.ts:79-90` (`isWindowWithinAvailability`)
- Test: `src/lib/admin/availability-coverage.test.ts` (create if absent; else append)

**Interfaces:**
- Consumes: `AvailabilitySlot` (`./types`), `ArrivalWindow` (`./arrival-window`), existing `businessWeekday`, `spanIsCovered`, `arrivalWindowHours`.
- Produces: unchanged signature `isWindowWithinAvailability(slots, isoDay, window): boolean` — only the zero-rows behavior changes. Both the client shading and the server gate (`placeAndAssignRequest`) call this, so the fallback fixes both at once.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/admin/availability-coverage.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isWindowWithinAvailability } from './availability-coverage';
import type { AvailabilitySlot } from './types';

// 2026-07-06 is a Monday; 2026-07-11 is a Saturday (business tz).
const MONDAY = '2026-07-06';
const SATURDAY = '2026-07-11';

describe('isWindowWithinAvailability — unconfigured fallback', () => {
  it('treats a tech with ZERO slots as available during default hours (Mon, morning)', () => {
    expect(isWindowWithinAvailability([], MONDAY, 'morning')).toBe(true);
    expect(isWindowWithinAvailability([], MONDAY, 'evening')).toBe(true);
    expect(isWindowWithinAvailability([], MONDAY, 'anytime')).toBe(true);
  });

  it('treats a tech with ZERO slots as OFF on weekends (default Mon–Fri only)', () => {
    expect(isWindowWithinAvailability([], SATURDAY, 'morning')).toBe(false);
  });

  it('does NOT fall back when the tech HAS rows but none on the queried weekday', () => {
    // Configured for Monday only → Saturday is a real day off, not "unconfigured".
    const monOnly: AvailabilitySlot[] = [
      { dayOfWeek: 1, startMinute: 8 * 60, endMinute: 20 * 60 } as AvailabilitySlot,
    ];
    expect(isWindowWithinAvailability(monOnly, SATURDAY, 'morning')).toBe(false);
    expect(isWindowWithinAvailability(monOnly, MONDAY, 'morning')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/admin/availability-coverage.test.ts`
Expected: FAIL — the zero-slot cases currently return `false` (the `spanIsCovered([], …)` fail-closed at `availability-coverage.ts:52`).

- [ ] **Step 3: Implement the fallback**

In `src/lib/admin/availability-coverage.ts`, add the default constants just below `const MINUTES_PER_HOUR = 60;` (line 24):

```typescript
// Bounded fallback for the UNCONFIGURED state (a tech with no availability rows
// at all — the common pre-setup state). NOT unbounded "always open": the same
// gate enforces server-side placement (placeAndAssignRequest), so an open default
// would let auto-assign place jobs at any hour. Mon–Fri 8:00 AM–8:00 PM exactly
// covers the morning/afternoon/evening/anytime window bounds. Weekends stay off
// until real hours are set (P1 availability UI). Org-configurable default = P1.
const DEFAULT_BUSINESS_DAY = { startMinute: 8 * 60, endMinute: 20 * 60 } as const;
const DEFAULT_BUSINESS_WEEKDAYS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]);
```

Then replace the body of `isWindowWithinAvailability` (lines 83-89) with:

```typescript
  const [startHour, endHour] = arrivalWindowHours(window);
  const winStart = startHour * MINUTES_PER_HOUR;
  const winEnd = endHour * MINUTES_PER_HOUR;
  const weekday = businessWeekday(isoDay);

  // Unconfigured tech (no rows at all) → bounded default business hours, so the
  // board is usable before hours are entered without silently allowing any hour.
  if (slots.length === 0) {
    if (!DEFAULT_BUSINESS_WEEKDAYS.has(weekday)) return false;
    return spanIsCovered([DEFAULT_BUSINESS_DAY], winStart, winEnd);
  }

  // Tech HAS rows: a weekday with no slot is a real day off → stays uncovered.
  const daySlots = slots.filter((slot) => slot.dayOfWeek === weekday);
  return spanIsCovered(daySlots, winStart, winEnd);
```

Update the doc-comment at lines 73-78 to describe the new fallback (replace the "Returns `true` when … NO" paragraph):

```typescript
/**
 * Does the technician's availability fully cover the proposed window on the
 * given business day? Slots are filtered to the day's weekday, then the window's
 * Eastern wall-clock hours are tested against their merged union.
 *
 * A tech with NO availability rows at all is "unconfigured" and falls back to
 * default business hours (Mon–Fri 8–8) so the board stays usable pre-setup. A
 * tech WITH rows but none on the queried weekday is genuinely off → uncovered.
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/admin/availability-coverage.test.ts`
Expected: PASS (all cases, including any pre-existing tests in the file).

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc --noEmit 2>&1 | grep availability-coverage || echo clean` and `npx eslint src/lib/admin/availability-coverage.ts`
Expected: clean, eslint exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/admin/availability-coverage.ts src/lib/admin/availability-coverage.test.ts
git commit -m "fix(calendar): default business hours for unconfigured techs (Bug 1: everything out-of-hours)"
```

---

### Task 2: Bug 2 (server) — unschedule mutation + route

**Files:**
- Modify: `src/lib/admin/scheduling-queries.ts` (add `unscheduleRequest` after `placeAndAssignRequest`, ~line 720)
- Create: `src/app/api/admin/requests/[id]/unschedule/route.ts`
- Test: `src/app/api/admin/requests/[id]/unschedule/route.test.ts`

**Interfaces:**
- Produces: `unscheduleRequest(organizationId: string, requestId: string): Promise<{ ok: true } | { ok: false; reason: 'request_not_found' | 'request_terminal'; currentStatus?: string }>` — nulls `scheduledDate`/`arrivalWindowStart`/`arrivalWindowEnd`/`assignedTo` and leaves `status` at `pending` via a status-guarded UPDATE. Consumed by the new route.
- Consumes (route): `getAdminSession`, `successResponse`/`errorResponse`, `slidingWindow`/`RATE_LIMITS`, `logAudit`, `after`, `syncRequestToCalendar`, `pushJobToHcp` — same imports the reschedule route uses.

- [ ] **Step 1: Add the `unscheduleRequest` mutation**

In `src/lib/admin/scheduling-queries.ts`, after `placeAndAssignRequest` ends (line 720), add. (Terminal statuses must not be unscheduled — mirror the reschedule route's `request_terminal` guard. The terminal set in this codebase is `completed`/`cancelled`; confirm against `RequestStatus` and reuse any existing `TERMINAL_STATUSES` constant if present in this file.)

```typescript
/**
 * Clear a job's placement: null its schedule + arrival window and unassign it,
 * returning it to the unscheduled "to place" queue (status reset to 'pending').
 * The inverse of placeAndAssignRequest — backs drag-back-to-Unscheduled. A single
 * status-guarded UPDATE (neon-http has no transactions); terminal jobs are refused.
 */
export async function unscheduleRequest(
  organizationId: string,
  requestId: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: "request_not_found" | "request_terminal"; currentStatus?: string }
> {
  const [existing] = await db
    .select({ status: serviceRequests.status })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)!));
  if (!existing) return { ok: false, reason: "request_not_found" };
  if (existing.status === "completed" || existing.status === "cancelled") {
    return { ok: false, reason: "request_terminal", currentStatus: existing.status };
  }

  const [updated] = await db
    .update(serviceRequests)
    .set({
      status: "pending",
      assignedTo: null,
      scheduledDate: null,
      arrivalWindowStart: null,
      arrivalWindowEnd: null,
      updatedAt: new Date(),
    })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(eq(serviceRequests.id, requestId), eq(serviceRequests.status, existing.status))!,
      ),
    )
    .returning({ id: serviceRequests.id });

  if (!updated) return { ok: false, reason: "request_not_found" };
  return { ok: true };
}
```

- [ ] **Step 2: Write the failing route validation test**

Create `src/app/api/admin/requests/[id]/unschedule/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getAdminSession: vi.fn() }));
vi.mock('@/lib/admin/scheduling-queries', () => ({ unscheduleRequest: vi.fn() }));
vi.mock('@/lib/admin/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/integrations/google-calendar/sync', () => ({ syncRequestToCalendar: vi.fn() }));
vi.mock('@/lib/integrations/housecall-pro/job-sync', () => ({ pushJobToHcp: vi.fn() }));

import { POST } from './route';
import { getAdminSession } from '@/lib/auth/session';
import { unscheduleRequest } from '@/lib/admin/scheduling-queries';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request('http://t/api', { method: 'POST' });

beforeEach(() => vi.clearAllMocks());

describe('POST unschedule', () => {
  it('401 without a session', async () => {
    (getAdminSession as unknown as vi.Mock).mockResolvedValue(null);
    const res = await POST(req() as never, ctx('11111111-1111-1111-1111-111111111111') as never);
    expect(res.status).toBe(401);
  });

  it('400 on a malformed id', async () => {
    (getAdminSession as unknown as vi.Mock).mockResolvedValue({ userId: 'u', organizationId: 'o' });
    const res = await POST(req() as never, ctx('not-a-uuid') as never);
    expect(res.status).toBe(400);
  });

  it('200 when the mutation succeeds', async () => {
    (getAdminSession as unknown as vi.Mock).mockResolvedValue({ userId: 'u', organizationId: 'o' });
    (unscheduleRequest as unknown as vi.Mock).mockResolvedValue({ ok: true });
    const res = await POST(req() as never, ctx('11111111-1111-1111-1111-111111111111') as never);
    expect(res.status).toBe(200);
  });

  it('409 when the job is terminal', async () => {
    (getAdminSession as unknown as vi.Mock).mockResolvedValue({ userId: 'u', organizationId: 'o' });
    (unscheduleRequest as unknown as vi.Mock).mockResolvedValue({ ok: false, reason: 'request_terminal', currentStatus: 'completed' });
    const res = await POST(req() as never, ctx('11111111-1111-1111-1111-111111111111') as never);
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/app/api/admin/requests/[id]/unschedule/route.test.ts`
Expected: FAIL — the route module does not exist yet.

- [ ] **Step 4: Implement the route**

Create `src/app/api/admin/requests/[id]/unschedule/route.ts` (mirrors the reschedule route's auth/rate-limit/audit/after pattern):

```typescript
import { NextRequest, after } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { unscheduleRequest } from "@/lib/admin/scheduling-queries";
import { syncRequestToCalendar } from "@/lib/integrations/google-calendar/sync";
import { pushJobToHcp } from "@/lib/integrations/housecall-pro/job-sync";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientIp(request: NextRequest): string {
  const raw = request.headers.get("x-forwarded-for");
  return raw?.split(",")[0]?.trim().slice(0, 45) || "unknown";
}

/**
 * POST /api/admin/requests/[id]/unschedule — drag-back-to-Unscheduled: clear the
 * job's placement (schedule/window/assignee) and return it to the queue. Admin
 * session + adminMutation rate limit + audit, mirroring the reschedule route.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const rateCheck = slidingWindow(
      `admin:request-unschedule:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const result = await unscheduleRequest(session.organizationId, id);
    if (!result.ok) {
      if (result.reason === "request_not_found") {
        return errorResponse("Request not found", "NOT_FOUND", 404);
      }
      return errorResponse(
        `Request cannot be unscheduled while it is '${result.currentStatus}'`,
        "REQUEST_TERMINAL",
        409,
      );
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "request_unscheduled",
      entity: "service_request",
      entityId: id,
      details: JSON.stringify({ cleared: ["scheduledDate", "arrivalWindow", "assignedTo"] }),
      ipAddress: clientIp(request),
    });

    // Mirror the cleared placement outward (idempotent, degrade-safe, no-op when
    // the org isn't connected) — same after() pattern as reschedule.
    after(() => syncRequestToCalendar(session.organizationId, id));
    after(() => pushJobToHcp(session.organizationId, id));

    return successResponse(result);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to unschedule request");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

> Note: confirm `"request_unscheduled"` is an accepted `logAudit` action; if the audit action is a union/enum, add it there in this step (one-line addition next to `"request_rescheduled"`).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/app/api/admin/requests/[id]/unschedule/route.test.ts` → PASS.
Run: `npx tsc --noEmit 2>&1 | grep -E "unschedule|scheduling-queries" || echo clean` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/admin/scheduling-queries.ts "src/app/api/admin/requests/[id]/unschedule/"
git commit -m "feat(calendar): server unschedule path (Bug 2: clear placement, return to queue)"
```

---

### Task 3: Bug 2 (client) — pure optimistic unschedule helper

**Files:**
- Modify: `src/lib/admin/calendar-optimistic.ts` (add `applyOptimisticUnschedule` after `applyOptimisticReschedule`, line 125)
- Test: `src/lib/admin/calendar-optimistic.test.ts` (create if absent; else append)

**Interfaces:**
- Produces: `applyOptimisticUnschedule(calendar: SchedulingCalendar, requestId: string): SchedulingCalendar` — removes the job from every lane + the unassigned pile, clears its window/assignee fields, and inserts it into `calendar.unscheduled`. Returns the SAME reference if the job isn't found. Consumed by Task 5's drop handler.
- Consumes: `SchedulingCalendar`, `DashboardRequest` (`./types`), existing `findJob` helper (already in this file).

- [ ] **Step 1: Write the failing test**

Append to `src/lib/admin/calendar-optimistic.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { applyOptimisticUnschedule } from './calendar-optimistic';
import type { SchedulingCalendar, DashboardRequest } from './types';

function job(id: string): DashboardRequest {
  return {
    id,
    arrivalWindowStart: '2026-07-06T12:00:00.000Z',
    arrivalWindowEnd: '2026-07-06T16:00:00.000Z',
    assignedToName: 'Tech A',
  } as DashboardRequest;
}

function board(): SchedulingCalendar {
  return {
    lanes: [{ technicianId: 'tech-a', jobs: [job('j1')] }],
    unassigned: [],
    unscheduled: [],
  } as unknown as SchedulingCalendar;
}

describe('applyOptimisticUnschedule', () => {
  it('moves a placed job into the unscheduled queue and clears its window', () => {
    const next = applyOptimisticUnschedule(board(), 'j1');
    expect(next.lanes[0].jobs).toHaveLength(0);
    expect(next.unscheduled.map((j) => j.id)).toContain('j1');
    const moved = next.unscheduled.find((j) => j.id === 'j1')!;
    expect(moved.arrivalWindowStart).toBeNull();
    expect(moved.arrivalWindowEnd).toBeNull();
  });

  it('returns the SAME reference when the job is not on the board', () => {
    const b = board();
    expect(applyOptimisticUnschedule(b, 'missing')).toBe(b);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/admin/calendar-optimistic.test.ts`
Expected: FAIL — `applyOptimisticUnschedule` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/lib/admin/calendar-optimistic.ts`, after `applyOptimisticReschedule` (line 125), add:

```typescript
/**
 * Apply an optimistic UNSCHEDULE: pull the job out of whatever lane / unassigned
 * pile it's in, clear its window + assignee, and drop it into the unscheduled
 * queue. Inverse of applyOptimisticReschedule. Returns the SAME reference when
 * the job can't be found (nothing to do — caller skips).
 */
export function applyOptimisticUnschedule(
  calendar: SchedulingCalendar,
  requestId: string,
): SchedulingCalendar {
  const job = findJob(calendar, requestId);
  if (!job) return calendar;

  const cleared: DashboardRequest = {
    ...job,
    arrivalWindowStart: null,
    arrivalWindowEnd: null,
    assignedToName: null,
  };

  const remove = (list: readonly DashboardRequest[]) =>
    list.filter((j) => j.id !== requestId);

  const lanes = calendar.lanes.map((lane) => ({
    ...lane,
    jobs: remove(lane.jobs),
  }));
  const unassigned = remove(calendar.unassigned);
  const unscheduled = [...remove(calendar.unscheduled), cleared];

  return { ...calendar, lanes, unassigned, unscheduled };
}
```

> If TypeScript reports `assignedToName` (or `arrivalWindowStart`) is not nullable on `DashboardRequest`, inspect the type in `src/lib/admin/types.ts` and clear only the fields it permits (the queue card reads `assignedToName` + `arrivalWindowStart`, both already nullable per `draggable-unscheduled-panel.tsx:28-29`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/admin/calendar-optimistic.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/admin/calendar-optimistic.ts src/lib/admin/calendar-optimistic.test.ts
git commit -m "feat(calendar): optimistic unschedule helper (Bug 2)"
```

---

### Task 4: Bug 2 (client) — Unscheduled droppable zone + dnd type

**Files:**
- Modify: `src/lib/admin/calendar-dnd.ts` (add the unscheduled drop-zone type + id)
- Modify: `src/components/admin/calendar/draggable-unscheduled-panel.tsx` (register `useDroppable` on the panel container)

**Interfaces:**
- Produces: `UnscheduledDropZoneData` (`{ kind: 'unscheduled' }`), `UNSCHEDULED_DROP_ID` constant, and a widened `DropZoneData` union so the drop handler can discriminate on `kind`. The panel `Card` becomes a droppable with `data: { kind: 'unscheduled' }`.
- Consumes: `@dnd-kit/core` `useDroppable`.

- [ ] **Step 1: Add the drop-zone type + id**

In `src/lib/admin/calendar-dnd.ts`, rename the window payload interface usage to a union. After the existing `DropZoneData` interface (line 31) add:

```typescript
/** The droppable payload for the "Unscheduled" queue panel — a drop here clears
 * the job's placement and returns it to the queue. */
export interface UnscheduledDropZoneData {
  readonly kind: "unscheduled";
}

/** Stable droppable id for the single Unscheduled-queue zone. */
export const UNSCHEDULED_DROP_ID = "drop:unscheduled";

/** Any drop target on the calendar: a window band or the unscheduled queue. */
export type CalendarDropData = DropZoneData | UnscheduledDropZoneData;
```

- [ ] **Step 2: Make the panel a droppable**

In `src/components/admin/calendar/draggable-unscheduled-panel.tsx`:

Add to the imports (line 3):

```typescript
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { dragJobId, UNSCHEDULED_DROP_ID, type DragJobData, type UnscheduledDropZoneData } from '@/lib/admin/calendar-dnd';
```

(Replace the existing single-import lines for `@dnd-kit/core` and `calendar-dnd` accordingly — keep `DashboardRequest`/`DASHBOARD_LIST_LIMIT` import as-is.)

In the `DraggableUnscheduledPanel` function body (before the `return`, line 109), register the droppable:

```typescript
  const dropData: UnscheduledDropZoneData = { kind: 'unscheduled' };
  const { setNodeRef, isOver } = useDroppable({ id: UNSCHEDULED_DROP_ID, data: dropData });
```

Attach it to the `Card` and add an over-state cue (line 110):

```typescript
    <Card
      ref={setNodeRef}
      className={`flex w-full flex-col p-3 lg:w-72 lg:shrink-0 transition-colors ${
        isOver ? 'ring-2 ring-amber-400 bg-amber-50/50 dark:bg-amber-950/20' : ''
      }`}
    >
```

> Confirm `Card` (`@/components/ui/card`) forwards `ref` to its root DOM node. If it does not, wrap the `Card` in a `<div ref={setNodeRef}>` instead and move the `isOver` ring class to that div.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "calendar-dnd|draggable-unscheduled" || echo clean` → clean.
Run: `npx eslint src/lib/admin/calendar-dnd.ts src/components/admin/calendar/draggable-unscheduled-panel.tsx` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/admin/calendar-dnd.ts src/components/admin/calendar/draggable-unscheduled-panel.tsx
git commit -m "feat(calendar): register Unscheduled panel as a droppable zone (Bug 2)"
```

---

### Task 5: Bug 2 (client) — drop-handler branch + unschedule hook call

**Files:**
- Modify: `src/hooks/use-reschedule-job.ts` (add an `unschedule` call)
- Modify: `src/components/admin/calendar/interactive-scheduling-calendar.tsx:464-470` (`handleDragEnd` — branch on the unscheduled target)

**Interfaces:**
- Consumes: `applyOptimisticUnschedule` (Task 3), `UnscheduledDropZoneData`/`UNSCHEDULED_DROP_ID`/`CalendarDropData` (Task 4), the new `POST /unschedule` route (Task 2).
- Produces: `useRescheduleJob()` additionally returns `unschedule(requestId: string): Promise<{ status: 'ok' } | { status: 'error'; message: string }>`.

- [ ] **Step 1: Add `unschedule` to the hook**

In `src/hooks/use-reschedule-job.ts`, extend `UseRescheduleJobResult` (line 39):

```typescript
interface UseRescheduleJobResult {
  readonly reschedule: (args: RescheduleArgs) => Promise<RescheduleResult>;
  readonly unschedule: (requestId: string) => Promise<{ status: 'ok' } | { status: 'error'; message: string }>;
  readonly isRescheduling: boolean;
}
```

Inside `useRescheduleJob`, before the `return` (line 136), add:

```typescript
  const unschedule = useCallback(
    async (requestId: string): Promise<{ status: 'ok' } | { status: 'error'; message: string }> => {
      setIsRescheduling(true);
      try {
        const res = await fetch(
          `/api/admin/requests/${encodeURIComponent(requestId)}/unschedule`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        );
        if (res.ok) return { status: 'ok' };
        const body = await res.json().catch(() => null);
        return { status: 'error', message: body?.error?.message ?? 'Failed to unschedule. Please try again.' };
      } catch {
        return { status: 'error', message: 'Could not connect to server. Please try again.' };
      } finally {
        setIsRescheduling(false);
      }
    },
    [],
  );
```

And return it: `return { reschedule, unschedule, isRescheduling };`

- [ ] **Step 2: Branch the drop handler**

In `src/components/admin/calendar/interactive-scheduling-calendar.tsx`:

Add to the calendar-dnd import the new names, and import the optimistic helper + the hook's `unschedule`. Where `reschedule` is destructured from `useRescheduleJob()`, change it to `const { reschedule, unschedule } = useRescheduleJob();`.

Replace the early-return guard + nothing-else case in `handleDragEnd` (lines 466-470) so an unscheduled-zone drop is handled BEFORE the window-only guard:

```typescript
    const dragData = event.active.data.current as DragJobData | undefined;
    const dropData = event.over?.data.current as CalendarDropData | undefined;
    if (!board || dragData?.kind !== 'job') return;

    // Drag-back-to-Unscheduled: clear the placement and return the card to the queue.
    if (dropData?.kind === 'unscheduled') {
      const prev = board;
      const next = applyOptimisticUnschedule(prev, dragData.requestId);
      if (next === prev) return;
      setBoard(next);
      const result = await unschedule(dragData.requestId);
      if (result.status === 'error') {
        setBoard(prev);
        onStatus(result.message, 'error');
      }
      onRefetch();
      return;
    }

    if (dropData?.kind !== 'window') return;
```

(The rest of `handleDragEnd` — the reschedule/reassign path from line 472 onward — is unchanged.)

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit 2>&1 | grep -E "interactive-scheduling-calendar|use-reschedule-job" || echo clean` → clean.
Run: `npx eslint src/hooks/use-reschedule-job.ts src/components/admin/calendar/interactive-scheduling-calendar.tsx` → exit 0.

- [ ] **Step 4: Manual verification (dnd can't be unit-tested cheaply)**

Run `npm run dev`, open `/admin/calendar` (day view), drag a placed job card onto the Unscheduled panel.
Expected: the panel highlights on hover; on drop the card leaves its lane and appears in "Unscheduled"; a refetch confirms it persisted (reload → still unscheduled). Drag it back onto a window band → it re-schedules.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-reschedule-job.ts src/components/admin/calendar/interactive-scheduling-calendar.tsx
git commit -m "feat(calendar): drag-to-unschedule drop handler + hook (Bug 2 complete)"
```

---

## Self-Review

**Spec coverage (against the design spec §4 bug fixes):**
- Bug 1 "everything out of hours" → Task 1 (default-hours fallback; the unsafe blanket fail-open is explicitly avoided — bounded to Mon–Fri 8–8). Availability-editing UI + org-config + FieldPulse precedence correctly deferred to P1 (stated in Global Constraints).
- Bug 2 "drag-back-to-plate" → Tasks 2 (server null-out path), 3 (optimistic), 4 (droppable + dnd type), 5 (drop-handler branch + hook). All three root-cause gaps (no droppable / handler ignores non-window / no server clear) are covered.

**Placeholder scan:** No TBD/TODO/"handle errors"; every code step shows complete code. Three explicit *verify-then-adjust* notes (audit-action union, `Card` ref forwarding, `DashboardRequest` nullability) are guarded confirmations, not deferred work — each names the exact file to check and the fallback.

**Type consistency:** `applyOptimisticUnschedule(calendar, requestId)` (Task 3) is consumed with that exact signature in Task 5. `unschedule(requestId)` hook (Task 5) matches the route path from Task 2. `CalendarDropData`/`UnscheduledDropZoneData`/`UNSCHEDULED_DROP_ID` (Task 4) are used verbatim in Tasks 4 and 5. `unscheduleRequest` return shape (Task 2 mutation) matches the route's `result.ok`/`result.reason` handling.

**Sequencing:** Tasks 1–4 are independent and can land in any order; Task 5 depends on 2, 3, and 4. Each task ends green and committed.
