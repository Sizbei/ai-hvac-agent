# Context Layer (Probook v3, Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the per-customer **context layer** — one thread per resolved customer plus an append-only, PII-safe event stream — and wire the existing intake/dispatch/comms paths to emit and read it, so a returning customer is recognized on any channel.

**Architecture:** Two new additive tables (`customer_threads`, `customer_events`) hung off the existing blind-index customer identity. A new `src/lib/context/` module exposes a pure event-label renderer (closed enum + exhaustive switch — no free-text, no PII), plus `resolveThread` / `appendEvent` / `getThread`. `appendEvent` is best-effort (copies the `recordStatusEvent` contract); `getThread` fails open internally. Emitters call `appendEvent` inside existing `after()` blocks; the intake read seam (where `loadCustomerContextById` runs today) additionally calls `getThread`.

**Tech Stack:** Next.js (App Router, `after()`), Drizzle ORM on neon-http (no transactions; `db.batch`; aggregates return strings), Postgres, Vitest.

**Source spec:** `docs/superpowers/specs/2026-06-24-probook-master-spec-v3.md` §6.1 (and §5.5 build notes). This plan implements **Phase 1** of §8's build sequence.

**Invariants preserved (from spec §2 + memory):** PII discipline (events hold enums/ids/label-keys only — never free text, never LLM-generated, renderer never dereferences `messages`/`customers` content); `appendEvent` never throws into a request path; `getThread` fails open; neon-http has no transactions; background work via `after()`, never detached promises.

**Operator gate:** the migration (`0023`, "ctx-1") is *authored* here via `db:generate` (writes a local SQL file — safe) but **applied by the operator** via `npm run db:migrate` (shared-DB change — not run by the implementer). Tasks that exercise the live tables are written test-first with the DB mocked, matching the codebase's vitest reality (DB-dependent suites don't connect in CI).

---

## File Structure

- `src/lib/db/schema.ts` — **modify**: add `customerThreads` + `customerEvents` table definitions.
- `drizzle/0023_*.sql` — **generated** by `db:generate` (ctx-1). Operator applies.
- `src/lib/context/event-labels.ts` — **create**: closed `EventKind` + `EventLabelKey` unions; pure `renderEventLabel(...)` (exhaustive switch + `never` check). The single source of the human one-liner. No I/O, no PII.
- `src/lib/context/event-labels.test.ts` — **create**: renderer unit tests.
- `src/lib/context/thread.ts` — **create**: `resolveThread`, `appendEvent`, `getThread`, types.
- `src/lib/context/thread.test.ts` — **create**: best-effort / fail-open behavior with the db mocked.
- `src/lib/requests/submit-session-request.ts` — **modify**: emit a `booking` event in the existing `after()` block.
- `src/lib/admin/status-events.ts` — **modify**: emit a `status_change` context event alongside the existing status event (best-effort).
- `src/app/api/chat/route.ts` — **modify**: at the `loadCustomerContextById` read seam, also call `getThread` (additive, fail-open).
- `src/lib/ai/voice-turn.ts` — **modify**: same additive `getThread` read at its context seam.

---

## Task 1: Schema — add `customer_threads` and `customer_events`

**Files:**
- Modify: `src/lib/db/schema.ts` (add two tables; place near `requestStatusEvents`, ~line 1807)

- [ ] **Step 1: Confirm imports**

`schema.ts` already imports `pgTable, uuid, text, integer, timestamp, index, uniqueIndex` (used throughout). If `uniqueIndex` is not yet imported, add it to the existing `drizzle-orm/pg-core` import. No new dependency.

- [ ] **Step 2: Add the two table definitions**

```ts
// ── Context layer (Probook v3, Phase 1) ───────────────────────────────────────
// One thread per resolved customer + an append-only, PII-free event stream.
// Mirrors the requestStatusEvents pattern: ids + enums/label-keys only, no free text.
export const customerThreads = pgTable(
  "customer_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    lastChannel: text("last_channel"), // 'voice' | 'sms' | 'web'
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    openEstimateCount: integer("open_estimate_count").notNull().default(0),
    status: text("status").notNull().default("active"), // 'active' | 'dormant'
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("customer_threads_org_customer_unique").on(
      table.organizationId,
      table.customerId,
    ),
  ],
);

export const customerEvents = pgTable(
  "customer_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => customerThreads.id, { onDelete: "cascade" }),
    // Structured, enum/label-only — the human one-liner is rendered at read-time
    // from these fields (see src/lib/context/event-labels.ts). NEVER free text.
    kind: text("kind").notNull(),
    refId: uuid("ref_id"), // serviceRequestId / messageId / estimateId, by kind
    jobType: text("job_type"),
    window: text("window"),
    labelKey: text("label_key"), // from the closed EventLabelKey union
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("customer_events_org_customer_at_idx").on(
      table.organizationId,
      table.customerId,
      table.at,
    ),
  ],
);
```

- [ ] **Step 3: Author the migration (does NOT apply it)**

Run: `npm run db:generate`
Expected: a new `drizzle/0023_*.sql` containing `CREATE TABLE "customer_threads"` and `CREATE TABLE "customer_events"` + the indexes, plus a `drizzle/meta/_journal.json` entry. **Do not run `db:migrate`** — the operator applies it.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0 (the new tables compile; they're not yet referenced elsewhere).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema.ts drizzle/0023_*.sql drizzle/meta/_journal.json
git commit -m "feat(context): add customer_threads + customer_events tables (ctx-1)"
```

---

## Task 2: Pure event-label renderer (closed enum + exhaustive switch)

This is the PII-safety mechanism: the only place an event becomes human-readable, with a compile-time-exhaustive map and a generic fallback — it never reads `messages`/`customers` content.

**Files:**
- Create: `src/lib/context/event-labels.ts`
- Test: `src/lib/context/event-labels.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/context/event-labels.test.ts
import { describe, it, expect } from "vitest";
import { renderEventLabel, type CustomerEventView } from "./event-labels";

const base: CustomerEventView = {
  kind: "booking",
  labelKey: "booked",
  jobType: "no_cool",
  window: "afternoon",
  refId: null,
};

describe("renderEventLabel", () => {
  it("renders a booking with jobType and window", () => {
    expect(renderEventLabel(base)).toBe("Booked no_cool (afternoon)");
  });

  it("renders a reassignment without a window", () => {
    expect(renderEventLabel({ ...base, kind: "status_change", labelKey: "reassigned", window: null }))
      .toBe("Job reassigned (no_cool)");
  });

  it("renders an outbound send", () => {
    expect(renderEventLabel({ ...base, kind: "outbound", labelKey: "outbound_sent", jobType: null, window: null }))
      .toBe("Outbound message sent");
  });

  it("falls back to a generic non-PII string for an unknown/absent label", () => {
    expect(renderEventLabel({ ...base, labelKey: null })).toBe("Activity recorded");
    // @ts-expect-error — an out-of-union label is a type error AND renders generic
    expect(renderEventLabel({ ...base, labelKey: "totally_unknown" })).toBe("Activity recorded");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/context/event-labels.test.ts`
Expected: FAIL — `Cannot find module './event-labels'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/context/event-labels.ts

/** Closed set of event kinds written to customer_events. */
export type EventKind =
  | "call"
  | "sms_in"
  | "sms_out"
  | "web_msg"
  | "booking"
  | "status_change"
  | "outbound"
  | "forecast_note"
  | "note";

/**
 * Closed set of label keys. The data-quality `note` case uses fixed ISSUE CODES,
 * never a message string. Extend this union (and the switch below) together.
 */
export type EventLabelKey =
  | "booked"
  | "reassigned"
  | "completed"
  | "cancelled"
  | "sms_in"
  | "sms_out"
  | "web_msg"
  | "call_in"
  | "outbound_sent"
  | "quality_missing_address"
  | "quality_dup_suspected"
  | "forecast_note";

/** The structured, PII-free fields the renderer is allowed to read. */
export interface CustomerEventView {
  readonly kind: EventKind;
  readonly labelKey: EventLabelKey | null;
  readonly jobType: string | null;
  readonly window: string | null;
  readonly refId: string | null;
}

const GENERIC = "Activity recorded";

function withType(prefix: string, jobType: string | null): string {
  return jobType ? `${prefix} (${jobType})` : prefix;
}

/**
 * Render a customer event to a human one-liner. PURE — reads ONLY the structured
 * fields above; it NEVER dereferences refId into messages/customers (no PII).
 * Unknown/absent labels render the generic fallback. The exhaustive switch has a
 * compile-time `never` check so a new EventLabelKey can't be silently unrendered.
 */
export function renderEventLabel(e: CustomerEventView): string {
  switch (e.labelKey) {
    case "booked": {
      const base = withType("Booked", e.jobType);
      return e.window ? `${base.replace(/\)$/, "")}, ${e.window})`.replace("Booked, ", "Booked ") : base;
    }
    case "reassigned":
      return withType("Job reassigned", e.jobType);
    case "completed":
      return withType("Job completed", e.jobType);
    case "cancelled":
      return withType("Job cancelled", e.jobType);
    case "sms_in":
      return "Inbound text";
    case "sms_out":
      return "Text sent";
    case "web_msg":
      return "Web chat message";
    case "call_in":
      return "Inbound call";
    case "outbound_sent":
      return "Outbound message sent";
    case "quality_missing_address":
      return "Flagged: missing address";
    case "quality_dup_suspected":
      return "Flagged: possible duplicate";
    case "forecast_note":
      return "Forecast note";
    case null:
      return GENERIC;
    default: {
      // Exhaustiveness guard: a new EventLabelKey added without a case is a
      // compile error here. At runtime an out-of-union value renders generic.
      const _exhaustive: never = e.labelKey;
      void _exhaustive;
      return GENERIC;
    }
  }
}
```

> Note: the `"booked"` case must produce `"Booked no_cool (afternoon)"` and `"Booked no_cool"` (no window). Implement whichever form is clearest; the simplest correct version:
> ```ts
> case "booked": {
>   if (e.jobType && e.window) return `Booked ${e.jobType} (${e.window})`;
>   if (e.jobType) return `Booked ${e.jobType}`;
>   return "Booking recorded";
> }
> ```
> Use this simpler form and align the test's expected strings to it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/context/event-labels.test.ts`
Expected: PASS (4 tests). Adjust the `"booked"` expected strings to the simpler implementation if used.

- [ ] **Step 5: Commit**

```bash
git add src/lib/context/event-labels.ts src/lib/context/event-labels.test.ts
git commit -m "feat(context): pure PII-free event-label renderer (closed enum + exhaustive)"
```

---

## Task 3: `appendEvent` — best-effort, structured-only

**Files:**
- Create: `src/lib/context/thread.ts`
- Test: `src/lib/context/thread.test.ts`

- [ ] **Step 1: Write the failing test (db mocked)**

```ts
// src/lib/context/thread.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn();
const onConflictDoUpdate = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    insert: (...a: unknown[]) => insert(...a),
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { appendEvent } from "./thread";

beforeEach(() => {
  insert.mockReset();
  onConflictDoUpdate.mockReset();
});

describe("appendEvent", () => {
  it("never throws when the insert fails (best-effort)", async () => {
    insert.mockImplementation(() => { throw new Error("db down"); });
    await expect(
      appendEvent("org1", "cust1", { kind: "booking", labelKey: "booked", refId: "sr1" }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/context/thread.test.ts`
Expected: FAIL — `appendEvent` not exported.

- [ ] **Step 3: Write minimal implementation (file scaffold + appendEvent)**

```ts
// src/lib/context/thread.ts
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerEvents, customerThreads } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { logger } from "@/lib/logger";
import type { EventKind, EventLabelKey } from "./event-labels";

export interface AppendEventInput {
  readonly kind: EventKind;
  readonly labelKey: EventLabelKey;
  readonly refId?: string | null;
  readonly jobType?: string | null;
  readonly window?: string | null;
  readonly channel?: "voice" | "sms" | "web" | null;
}

/**
 * Append one PII-free event for a customer, lazily ensuring the thread row.
 * BEST-EFFORT: wraps everything in try/catch and never throws into the caller's
 * request path (same contract as recordStatusEvent). Structured fields only —
 * there is no free-text `summary` parameter by design.
 */
export async function appendEvent(
  organizationId: string,
  customerId: string,
  evt: AppendEventInput,
): Promise<void> {
  try {
    const threadId = await ensureThreadId(organizationId, customerId, evt.channel ?? null);
    if (!threadId) return;
    await db.insert(customerEvents).values({
      organizationId,
      customerId,
      threadId,
      kind: evt.kind,
      refId: evt.refId ?? null,
      jobType: evt.jobType ?? null,
      window: evt.window ?? null,
      labelKey: evt.labelKey,
    });
  } catch (error) {
    logger.error(
      { error, organizationId, customerId, kind: evt.kind },
      "Failed to append customer event (non-fatal)",
    );
  }
}
```

(`ensureThreadId` is implemented in Task 4; for this step add a temporary stub that returns a fixed id so the file compiles, then replace it in Task 4. Stub:)

```ts
async function ensureThreadId(
  _organizationId: string,
  _customerId: string,
  _channel: string | null,
): Promise<string | null> {
  return "stub"; // replaced in Task 4
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/context/thread.test.ts`
Expected: PASS (the insert throws, `appendEvent` swallows it, resolves undefined).

- [ ] **Step 5: Commit**

```bash
git add src/lib/context/thread.ts src/lib/context/thread.test.ts
git commit -m "feat(context): appendEvent (best-effort, structured-only)"
```

---

## Task 4: `resolveThread` + `ensureThreadId` (lazy thread creation)

**Files:**
- Modify: `src/lib/context/thread.ts`
- Test: `src/lib/context/thread.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to thread.test.ts
import { resolveThread } from "./thread";

it("resolveThread returns the existing thread id without inserting", async () => {
  // Arrange: a select chain that yields one row.
  const limit = vi.fn().mockResolvedValue([{ id: "thread1" }]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  // re-mock db.select for this test
  (await import("@/lib/db")).db.select = vi.fn(() => ({ from })) as never;

  const out = await resolveThread("org1", "cust1");
  expect(out).toEqual({ threadId: "thread1", customerId: "cust1" });
});
```

> If mutating the imported `db` mock is awkward, extend the top-level `vi.mock("@/lib/db", ...)` to include a `select` chain (`from→where→limit`) returning `[{ id: "thread1" }]`. Keep one consistent mock shape across tests.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/context/thread.test.ts`
Expected: FAIL — `resolveThread` not exported.

- [ ] **Step 3: Implement `resolveThread` + replace the `ensureThreadId` stub**

```ts
export interface ResolvedThread {
  readonly threadId: string;
  readonly customerId: string;
}

/** Find the customer's thread id; returns null if none exists yet (no insert). */
export async function resolveThread(
  organizationId: string,
  customerId: string,
): Promise<ResolvedThread | null> {
  const [row] = await db
    .select({ id: customerThreads.id })
    .from(customerThreads)
    .where(withTenant(customerThreads, organizationId, eq(customerThreads.customerId, customerId)))
    .limit(1);
  return row ? { threadId: row.id, customerId } : null;
}

/**
 * Get-or-create the thread id. Uses onConflictDoUpdate against the
 * (org, customer) unique index so concurrent first events don't 500 on
 * neon-http (no transactions). Also refreshes lastChannel/lastEventAt.
 */
async function ensureThreadId(
  organizationId: string,
  customerId: string,
  channel: string | null,
): Promise<string | null> {
  const [row] = await db
    .insert(customerThreads)
    .values({
      organizationId,
      customerId,
      lastChannel: channel,
      lastEventAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [customerThreads.organizationId, customerThreads.customerId],
      set: { lastChannel: channel, lastEventAt: sql`now()`, updatedAt: sql`now()` },
    })
    .returning({ id: customerThreads.id });
  return row?.id ?? null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/context/thread.test.ts`
Expected: PASS (resolveThread + the Task 3 best-effort test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/context/thread.ts src/lib/context/thread.test.ts
git commit -m "feat(context): resolveThread + lazy thread upsert (CAS-safe on neon-http)"
```

---

## Task 5: `getThread` — internal fail-open read

**Files:**
- Modify: `src/lib/context/thread.ts`
- Test: `src/lib/context/thread.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to thread.test.ts
import { getThread, EMPTY_THREAD } from "./thread";

it("getThread fails open: returns an empty thread on a DB error (never throws)", async () => {
  (await import("@/lib/db")).db.select = vi.fn(() => { throw new Error("db down"); }) as never;
  const out = await getThread("org1", "cust1");
  expect(out).toEqual(EMPTY_THREAD);
  expect(out.events).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/context/thread.test.ts`
Expected: FAIL — `getThread` / `EMPTY_THREAD` not exported.

- [ ] **Step 3: Implement `getThread` (fails open internally)**

```ts
import { renderEventLabel, type CustomerEventView } from "./event-labels";

export interface ThreadEventLine {
  readonly at: Date;
  readonly kind: string;
  readonly label: string; // rendered, PII-free
}

export interface CustomerThreadView {
  readonly exists: boolean;
  readonly lastChannel: string | null;
  readonly openEstimateCount: number;
  readonly events: readonly ThreadEventLine[];
}

/** Benign empty result — returned on any read error (fail open) or no thread. */
export const EMPTY_THREAD: CustomerThreadView = {
  exists: false,
  lastChannel: null,
  openEstimateCount: 0,
  events: [],
};

/**
 * Read the customer's thread + recent events, rendered to PII-free lines.
 * FAILS OPEN INTERNALLY: any DB error/timeout returns EMPTY_THREAD rather than
 * throwing, so every call site is fail-open by construction (callers need no
 * try/catch). Mirrors how the intake path treats loadCustomerContextById today.
 */
export async function getThread(
  organizationId: string,
  customerId: string,
  limit = 20,
): Promise<CustomerThreadView> {
  try {
    const [thread] = await db
      .select({
        lastChannel: customerThreads.lastChannel,
        openEstimateCount: customerThreads.openEstimateCount,
      })
      .from(customerThreads)
      .where(withTenant(customerThreads, organizationId, eq(customerThreads.customerId, customerId)))
      .limit(1);
    if (!thread) return EMPTY_THREAD;

    const rows = await db
      .select({
        at: customerEvents.at,
        kind: customerEvents.kind,
        labelKey: customerEvents.labelKey,
        jobType: customerEvents.jobType,
        window: customerEvents.window,
        refId: customerEvents.refId,
      })
      .from(customerEvents)
      .where(withTenant(customerEvents, organizationId, eq(customerEvents.customerId, customerId)))
      .orderBy(desc(customerEvents.at))
      .limit(limit);

    return {
      exists: true,
      lastChannel: thread.lastChannel,
      openEstimateCount: thread.openEstimateCount,
      events: rows.map((r) => ({
        at: r.at,
        kind: r.kind,
        label: renderEventLabel({
          kind: r.kind as CustomerEventView["kind"],
          labelKey: r.labelKey as CustomerEventView["labelKey"],
          jobType: r.jobType,
          window: r.window,
          refId: r.refId,
        }),
      })),
    };
  } catch (error) {
    logger.error({ error, organizationId, customerId }, "getThread failed (fail-open)");
    return EMPTY_THREAD;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/context/thread.test.ts`
Expected: PASS (all thread tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → exit 0.
```bash
git add src/lib/context/thread.ts src/lib/context/thread.test.ts
git commit -m "feat(context): getThread (internal fail-open, renders PII-free lines)"
```

---

## Task 6: Wire the booking emitter (`submit-session-request`)

**Files:**
- Modify: `src/lib/requests/submit-session-request.ts` (the existing `after(...)` block that pushes to HCP/FieldPulse + classifies the session)

- [ ] **Step 1: Add a best-effort `appendEvent` in the existing `after()` block**

Locate the `after(() => pushJobToHcp(...))` cluster (the post-commit background work after a service request is created). Add, alongside it:

```ts
import { appendEvent } from "@/lib/context/thread";
// ...inside the same after()-block region, after the serviceRequest is created:
after(() =>
  appendEvent(organizationId, serviceRequest.customerId, {
    kind: "booking",
    labelKey: "booked",
    refId: serviceRequest.id,
    jobType: serviceRequest.jobType ?? null,
    window: serviceRequest.preferredWindow ?? null,
    channel: "web",
  }),
);
```

Use the actual variable names present in the file (`serviceRequest`, `organizationId`); if `customerId` is nullable at this point, guard with `if (serviceRequest.customerId)`. `appendEvent` is itself best-effort, so no extra try/catch is needed.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Run the request submit suite (if present)**

Run: `npx vitest run src/lib/requests`
Expected: existing tests still pass (the new call is fire-and-forget in `after()`; mock `@/lib/context/thread` if a suite asserts on `after` callbacks).

- [ ] **Step 4: Commit**

```bash
git add src/lib/requests/submit-session-request.ts
git commit -m "feat(context): emit booking event on session-request submit"
```

---

## Task 7: Wire the intake reader (`getThread` at the existing context seam)

**Files:**
- Modify: `src/app/api/chat/route.ts` (where `loadCustomerContextById` / `lookupCustomerContext` runs)
- Modify: `src/lib/ai/voice-turn.ts` (its `loadCustomerContextById` call site)

- [ ] **Step 1: Additive, fail-open read in chat route**

At the seam where the chat route resolves `CustomerContext` (after the contact slot fills), add a parallel `getThread` read and fold a one-line "recognized across channels" signal into the existing hint. Because `getThread` fails open, no try/catch is needed:

```ts
import { getThread } from "@/lib/context/thread";
// after customerContext is resolved and customerId is known:
const thread = await getThread(organizationId, customerId);
const crossChannel =
  thread.exists && thread.lastChannel && thread.lastChannel !== "web"
    ? `\n[CONTEXT] This customer last contacted us via ${thread.lastChannel}.`
    : "";
// append `crossChannel` to the system-prompt hint string alongside buildCustomerContextHint(...)
```

Keep this purely additive to the prompt hint — do not change the existing `buildCustomerContextHint` behavior. The PII-free `thread.events` lines may optionally be summarized into the hint later (Phase 2+); Phase 1 only needs cross-channel recognition.

- [ ] **Step 2: Same additive read in voice-turn**

In `voice-turn.ts`, at its `loadCustomerContextById` call (customerId resolved from ANI), add the identical `getThread` read + `crossChannel` hint append (channel `"voice"` is the current one, so the signal fires when `lastChannel` is `sms`/`web`).

- [ ] **Step 3: Typecheck + targeted tests**

Run: `npx tsc --noEmit` → exit 0.
Run: `npx vitest run src/lib/ai/voice-turn.test.ts` → the existing voice-turn suite passes (add `getThread` to its `@/lib/context/thread` mock returning `EMPTY_THREAD`).

- [ ] **Step 4: Full gates**

Run: `npx tsc --noEmit && npm run lint && npx vitest run src/lib/context`
Expected: typecheck clean, lint clean, context suite green.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/chat/route.ts src/lib/ai/voice-turn.ts
git commit -m "feat(context): read getThread at intake seams for cross-channel recognition"
```

---

## Done criteria (maps to spec G1)

- `customer_threads` + `customer_events` exist (migration authored; operator applies).
- One thread per resolved customer; events are append-only, structured, PII-free; the renderer is exhaustive and never dereferences PII.
- `appendEvent` never throws into a request path; `getThread` fails open.
- A booking emits a `booking` event; the intake read recognizes a customer's prior channel.
- `npx tsc --noEmit`, `npm run lint`, and `npx vitest run src/lib/context` are green.

**Out of scope for Phase 1 (later phases):** emitting `status_change`/`sms`/`outbound` events from every site (add incrementally as those paths are touched), the `openEstimateCount` denormalization refresh, and summarizing `thread.events` into the prompt. These don't block G1.
